import { createMemo } from "solid-js"
import { map, pipe, sortBy } from "remeda"
import { useSync } from "../context/sync"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

export function providerAuthFailureMessage(_error: unknown) {
  return "Guarded SecretBroker credential entry is unavailable. HorizonCode does not use raw environment, config, or legacy Auth credentials for provider dispatch."
}

/**
 * Environment credentials are reported by variable name only. Raw credential
 * values are never read, shown, or offered as editable Settings values.
 */
export function providerProvenance(input: {
  source: string
  env: readonly string[]
  connected: boolean
  anonymousOffer?: boolean
}): string | undefined {
  if (!input.connected) return undefined
  if (input.anonymousOffer) return "Anonymous OpenCode offer · endpoint not probed"
  if (input.source === "env") {
    if (input.env.length === 0) return undefined
    return `Legacy environment source detected · provider-declared variables: ${input.env.join(", ")} · not used for dispatch`
  }
  if (input.source === "api") return "Legacy Auth credential detected · not used for dispatch"
  if (input.source === "config") return "Provider configuration present · credential status unknown; dispatch unavailable"
  return "SecretBroker reference or provider configuration present · dispatch unavailable pending Guarded transport"
}

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption = (ProviderOptionBase & { type: "provider"; providerID: string }) | (ProviderOptionBase & { type: "custom" })

export function normalizeCustomProviderID(input: string): string | undefined {
  const trimmed = input.trim()
  const scoped = trimmed.startsWith("@") ? /^@[^/\s]+\/([^/\s]+)$/.exec(trimmed)?.[1] : trimmed
  if (!scoped || scoped.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(scoped)) return undefined
  return scoped
}

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return [
    ...pipe(
      list,
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          opencode: "(Recommended)",
          anthropic: "(SecretBroker transport unavailable)",
          openai: "(SecretBroker transport unavailable)",
          "opencode-go": "(credentialed route unavailable)",
        }[provider.id],
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
      })),
    ),
    {
      type: "custom",
      title: "Other",
      value: "__opencode_custom_provider__",
      description: "Credential entry unavailable until Guarded credential-write support is enabled",
      category: "Providers",
    },
  ]
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()

  return createMemo(() =>
    pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            ...provider,
            description: "Guarded credential entry is unavailable",
            onSelect() {
              toast.show({
                message: "Custom provider credentials are unavailable until Guarded credential-write support is enabled.",
                variant: "info",
              })
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)
        const info = sync.data.provider_next.all.find((item) => item.id === providerID)
        const anonymousOffer = sync.data.provider_next.anonymousFreeProviders?.includes(providerID)
        const provenance = info
          ? providerProvenance({ source: info.source, env: info.env, connected, anonymousOffer })
          : undefined

        return {
          ...provider,
          description: [provider.description, provenance].filter(Boolean).join(" · ") || undefined,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          async onSelect() {
            if (consoleManaged) {
              const org = sync.data.console_state.activeOrgName
              toast.show({
                message: `${provider.title} is managed by your OpenCode Console organization${org ? ` (${org})` : ""}. Its credentials are not edited here.`,
                variant: "info",
              })
              return
            }

            if (connected) {
              dialog.replace(() => <DialogModel providerID={providerID} />)
              return
            }

            toast.show({
              message: `${provider.title} has no usable credential reference. Guarded SecretBroker credential entry and OAuth transport are unavailable.`,
              variant: "info",
            })
          },
        }
      }),
    ),
  )
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Select a connected provider/model" options={options()} />
}
