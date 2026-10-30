import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { ModelsDev } from "@horizoncode/core/models-dev"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import { Auth } from "@/auth"
import { readSecureTTYInput, SecureInputError } from "@/auth/secure-input"
import { effectCmd } from "../effect-cmd"
import * as Prompt from "../effect/prompt"

const MAX_PROVIDERS = 64
const MAX_MODELS = 24

export interface ProviderCatalogEntry {
  readonly id: string
  readonly name: string
  readonly models: readonly string[]
}

type CatalogInput = Record<string, { readonly name?: string; readonly models?: Record<string, unknown> } | undefined>

const boundedName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)

/**
 * Deterministic, bounded provider/model projection for the interactive command.
 * `limit` bounds a *listing*; an explicitly named provider is resolved against
 * the full catalog so a large catalog cannot hide a valid id behind the cap.
 */
export function providerCatalog(input: CatalogInput, limit = MAX_PROVIDERS): ProviderCatalogEntry[] {
  return Object.entries(input)
    .filter(([id]) => /^[^\s\u0000-\u001f\u007f]{1,128}$/.test(id))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limit)
    .map(([id, provider]) => ({
      id,
      name: boundedName(provider?.name) ? provider.name : id,
      models: Object.keys(provider?.models ?? {})
        .filter((model) => /^[^\s\u0000-\u001f\u007f]{1,128}$/.test(model))
        .sort()
        .slice(0, MAX_MODELS),
    }))
}

export interface ProviderEntryIO {
  write(text: string): void
  selectProvider(providers: readonly ProviderCatalogEntry[]): Promise<string | undefined>
  readSecureInput(prompt: string): Promise<Uint8Array>
}

export type ProviderEntryResult =
  | { readonly status: "unavailable" }
  | { readonly status: "cancelled" }
  | { readonly status: "denied"; readonly providerId: string }
  | { readonly status: "written"; readonly providerId: string; readonly metadata: SecretBrokerV1.MetadataV1 }

export interface ProviderEntryInput {
  readonly catalog: CatalogInput
  readonly io: ProviderEntryIO
  readonly mutationAvailable: boolean
  readonly issueHandle: (input: {
    readonly bytes: Uint8Array
    readonly providerId: string
    readonly operation: "put" | "rotate" | "revoke"
    readonly expectedVersion?: number
    readonly idempotencyKey: string
  }) => Promise<string>
  readonly putCredential: (request: SecretBrokerV1.PutRequestV1) => Promise<SecretBrokerV1.MetadataV1>
  readonly newIdempotencyKey?: () => string
}

const idempotencyKey = (value: string | undefined) => {
  if (value === undefined) return `put_${randomUUID()}`
  return /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined
}

/**
 * Bounded interactive credential entry. The key is only ever handed to the
 * trusted issue callback (which binds and zeroizes it); it is never included in
 * output, error text, or the put request.
 */
export async function runProviderCredentialEntry(input: ProviderEntryInput): Promise<ProviderEntryResult> {
  if (!input.mutationAvailable) {
    input.io.write(
      "Guarded provider credential entry is unavailable: no trusted credential-write grant channel is installed.",
    )
    return { status: "unavailable" }
  }

  const providers = providerCatalog(input.catalog)
  if (providers.length === 0) {
    input.io.write("No providers are available in the local catalog.")
    return { status: "unavailable" }
  }

  input.io.write("Providers and models:")
  for (const provider of providers) {
    input.io.write(`- ${provider.name} (${provider.id})`)
    input.io.write(`  models: ${provider.models.length === 0 ? "(none)" : provider.models.join(", ")}`)
  }

  const selected = await input.io.selectProvider(providers)
  if (selected === undefined) {
    input.io.write("Credential entry cancelled.")
    return { status: "cancelled" }
  }
  const provider = providers.find((entry) => entry.id === selected)
  if (!provider) {
    input.io.write(`Unknown provider "${selected}".`)
    return { status: "denied", providerId: selected }
  }

  const key = idempotencyKey(input.newIdempotencyKey?.())
  if (!key) {
    input.io.write("Credential entry could not allocate a bounded idempotency key.")
    return { status: "denied", providerId: provider.id }
  }

  input.io.write(`Enter the API key for ${provider.name} (${provider.id}) through masked terminal input.`)
  let bytes: Uint8Array
  try {
    bytes = await input.io.readSecureInput("API key: ")
  } catch (error) {
    input.io.write(error instanceof SecureInputError ? error.message : "Credential entry failed.")
    return { status: "cancelled" }
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    bytes?.fill?.(0)
    input.io.write("Credential is empty.")
    return { status: "cancelled" }
  }

  let handle: string
  try {
    handle = await input.issueHandle({
      bytes,
      providerId: provider.id,
      operation: "put",
      idempotencyKey: key,
    })
  } catch {
    // The trusted issuer owns and zeroizes the bytes; clearing again is harmless.
    bytes.fill(0)
    input.io.write("Guarded credential input is unavailable.")
    return { status: "denied", providerId: provider.id }
  }

  try {
    const metadata = await input.putCredential({
      schemaVersion: 1,
      providerId: provider.id,
      secureInputHandle: handle,
      idempotencyKey: key,
    })
    input.io.write(`Credential stored for ${provider.name} (${provider.id}) at version ${metadata.version}.`)
    return { status: "written", providerId: provider.id, metadata }
  } catch {
    // Never surface lower-level errors: they may carry rejected credential bytes.
    input.io.write("Guarded credential write was denied; no credential was stored.")
    return { status: "denied", providerId: provider.id }
  }
}

const hostPrincipal: TrustedPrincipal = { kind: "host_os" }

const withPrincipal = <Value, Error>(effect: Effect.Effect<Value, Error>) =>
  Effect.provideService(effect, TrustedPrincipalContext, { principal: hostPrincipal })

export const ProviderCommand = effectCmd({
  command: "provider",
  aliases: ["connect"],
  describe: "enter a provider API key through the guarded native credential channel",
  // Global credential state only; no project instance is required.
  instance: false,
  builder: (yargs) =>
    yargs.option("provider", {
      alias: ["p"],
      describe: "provider id to update (skips provider selection)",
      type: "string",
    }),
  handler: Effect.fn("Cli.provider")(function* (args) {
    const auth = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service
    const catalog = yield* modelsDev.get()
    const available = yield* withPrincipal(auth.credentialMutationAvailable()).pipe(
      Effect.orElseSucceed(() => false),
    )
    if (!available) {
      process.stdout.write(
        "Guarded provider credential entry is unavailable: no trusted credential-write grant channel is installed. No credential was read or stored.\n",
      )
      return
    }

    const requested = (args as { provider?: string }).provider
    let providerID = requested
    if (!providerID) {
      const providers = providerCatalog(catalog)
      const choice = yield* Prompt.autocomplete({
        message: "Select provider",
        maxItems: 8,
        options: providers.map((provider) => ({ label: `${provider.name} (${provider.id})`, value: provider.id })),
      })
      if (Option.isNone(choice)) {
        process.stdout.write("Credential entry cancelled.\n")
        return
      }
      providerID = choice.value
    }

    // An explicit --provider resolves against the whole catalog; only the
    // interactive listing is capped.
    if (requested) {
      const named = providerCatalog(catalog, Number.MAX_SAFE_INTEGER).find((entry) => entry.id === requested)
      if (!named) {
        process.stdout.write(`Unknown provider "${requested}".\n`)
        return
      }
    }
    const entryCatalog: CatalogInput = requested ? { [requested]: catalog[requested] } : catalog
    yield* Effect.promise(() =>
      runProviderCredentialEntry({
        catalog: entryCatalog,
        io: {
          write: (text) => process.stdout.write(text + "\n"),
          selectProvider: async () => providerID,
          readSecureInput: (prompt) => readSecureTTYInput({ prompt }),
        },
        mutationAvailable: true,
        issueHandle: (input) => Effect.runPromise(withPrincipal(auth.issueCredentialHandle(input))),
        putCredential: (request) => Effect.runPromise(withPrincipal(auth.putCredential(request))),
      }),
    )
  }),
})

export * as Provider from "./provider"
