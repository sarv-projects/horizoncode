import { createMemo, createSignal, onMount } from "solid-js"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useBindings } from "../keymap"

const SEARCH_ROUTE_IDS = ConfigV1.WEB_SEARCH_ROUTE_IDS
type SearchRouteID = NonNullable<NonNullable<ConfigV1.Info["websearch"]>["enabled"]>[number]
type SearchRouteClass = "DIRECT_SEARCH" | "GROUNDED_MODEL_SEARCH"
type SearchCostClass = "FREE" | "PAID" | "TRIAL" | "UNKNOWN"
type SearchAuthSource = "none" | "saved_credential" | "secret_broker" | "environment" | "model_provider" | "unknown"
type SearchProviderStatus = {
  provider: SearchRouteID
  configured: boolean
  status: "disabled" | "unconfigured" | "unavailable" | "ready" | "rate_limited"
  available: boolean
  costClass: SearchCostClass
  authSource: SearchAuthSource
  freshness: "unknown"
  providerHealth: "not_probed"
  unavailableReason?: string
  lastAttemptStatus?: "succeeded" | "failed" | "rate_limited" | "retryable_failure" | "empty" | "not_dispatched" | "unknown"
  lastFailureAt?: string
  lastError?: string
  lastStatusCode?: number
  lastAttemptAt?: string
  retryAfterMs?: number
  cooldownUntil?: string
}
type WebSearchConfig = {
  querySharingConsent?: "anonymous_free_v1"
  byoConsents?: { route: SearchRouteID; consent: "secret_broker_unknown_cost_v1" }[]
  enabled?: SearchRouteID[]
  order?: SearchRouteID[]
}
type SearchSettingsChoice =
  | { kind: "route"; route: SearchRouteID }
  | { kind: "revoke-consent"; route: SearchRouteID }
type ConfigResponse = { websearch?: WebSearchConfig; [key: string]: unknown }
const BYO_UNAVAILABLE = "After separate confirmation, this route is added to the cascade. Dispatch remains unavailable until the SecretBroker credential and Guarded transport acceptance pass."

function normalizeSettings(input?: WebSearchConfig) {
  const allowed = SEARCH_ROUTE_IDS as readonly SearchRouteID[]
  const anonymousConsent = input?.querySharingConsent === "anonymous_free_v1"
  const byoConsents = [...new Map((input?.byoConsents ?? [])
    .filter((entry) => entry.consent === "secret_broker_unknown_cost_v1" && ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS.includes(entry.route as (typeof ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS)[number]))
    .map((entry) => [entry.route, entry])).values()]
  const byoConsentRoutes = new Set(byoConsents.map((entry) => entry.route))
  const enabled = [...new Set(input?.enabled ?? (anonymousConsent ? ["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless"] as SearchRouteID[] : []))]
    .filter((id) => allowed.includes(id))
    .filter((id) => id.endsWith("_keyless") || id === "youcom_free" ? anonymousConsent : byoConsentRoutes.has(id))
  const requestedOrder = [...new Set(input?.order ?? ["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless", "brave", "exa", "youcom", "tavily", "firecrawl", "parallel"] as SearchRouteID[])].filter((id) => allowed.includes(id))
  const order = [...requestedOrder.filter((id) => enabled.includes(id)), ...enabled.filter((id) => !requestedOrder.includes(id))]
  return {
    ...(anonymousConsent ? { querySharingConsent: "anonymous_free_v1" as const } : {}),
    ...(byoConsents.length ? { byoConsents } : {}),
    enabled,
    order,
  }
}

function setEnabled(input: WebSearchConfig | undefined, id: SearchRouteID, enabled: boolean) {
  const current = normalizeSettings(input)
  const isByo = ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS.includes(id as (typeof ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS)[number])
  const byoConsents = new Map((current.byoConsents ?? []).map((entry) => [entry.route, entry]))
  // Route enablement and consent are separate settings. Disabling a provider
  // preserves its explicit cost/auth consent, so ordinary toggling does not
  // erase the user's choice. Revocation is a separate control.
  if (isByo && enabled) byoConsents.set(id, { route: id, consent: "secret_broker_unknown_cost_v1" })
  return normalizeSettings({
    ...(current.querySharingConsent ? { querySharingConsent: current.querySharingConsent } : {}),
    byoConsents: [...byoConsents.values()],
    enabled: enabled ? [...current.enabled, id] : current.enabled.filter((value) => value !== id),
    order: enabled ? [...current.order, id] : current.order.filter((value) => value !== id),
  })
}

function revokeRouteConsent(input: WebSearchConfig | undefined, id: SearchRouteID) {
  const current = normalizeSettings(input)
  const byoConsents = (current.byoConsents ?? []).filter((entry) => entry.route !== id)
  return normalizeSettings({
    ...(current.querySharingConsent ? { querySharingConsent: current.querySharingConsent } : {}),
    byoConsents,
    enabled: current.enabled.filter((route) => route !== id),
    order: current.order,
  })
}

function moveSearchRoute(input: WebSearchConfig | undefined, id: SearchRouteID, delta: -1 | 1) {
  const current = normalizeSettings(input)
  const index = current.order.indexOf(id)
  const nextIndex = index + delta
  if (index < 0 || nextIndex < 0 || nextIndex >= current.order.length) return current
  const order = [...current.order]
  ;[order[index], order[nextIndex]] = [order[nextIndex], order[index]]
  return { ...current, order }
}

const ROUTE_INFO: Record<SearchRouteID, { title: string; routeClass: SearchRouteClass; costClass: SearchCostClass; authSource: SearchAuthSource; details: string }> = {
  exa_keyless: {
    title: "Built-in default · Exa",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Anonymous built-in route; query sharing requires one first-use confirmation. Dispatch stays unavailable until Guarded acceptance; provider health is not probed.",
  },
  youcom_free: {
    title: "Built-in default · You.com",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Anonymous built-in route; query sharing requires one first-use confirmation. Dispatch stays unavailable until Guarded acceptance; provider health is not probed.",
  },
  firecrawl_keyless: {
    title: "Built-in default · Firecrawl",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Anonymous built-in route; query sharing requires one first-use confirmation. Dispatch stays unavailable until Guarded acceptance; provider health is not probed.",
  },
  parallel_keyless: {
    title: "Built-in default · Parallel",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Anonymous built-in route with provider rate limits; query sharing requires one first-use confirmation. Dispatch stays unavailable until Guarded acceptance; provider health is not probed.",
  },
  brave: {
    title: "Brave Search",
    routeClass: "DIRECT_SEARCH",
    costClass: "UNKNOWN",
    details: `Brave Search uses a SecretBroker credential reference. ${BYO_UNAVAILABLE}`,
    authSource: "secret_broker",
  },
  exa: {
    title: "Exa Search",
    routeClass: "DIRECT_SEARCH",
    costClass: "UNKNOWN",
    details: `Exa Search uses a SecretBroker credential reference. ${BYO_UNAVAILABLE}`,
    authSource: "secret_broker",
  },
  youcom: {
    title: "You.com Search",
    routeClass: "DIRECT_SEARCH",
    costClass: "UNKNOWN",
    details: `You.com Search uses a SecretBroker credential reference. ${BYO_UNAVAILABLE}`,
    authSource: "secret_broker",
  },
  tavily: {
    title: "Tavily Search",
    routeClass: "DIRECT_SEARCH",
    costClass: "UNKNOWN",
    details: `Tavily Search uses a SecretBroker credential reference. Search depth is fixed to basic. ${BYO_UNAVAILABLE}`,
    authSource: "secret_broker",
  },
  firecrawl: {
    title: "Firecrawl Search",
    routeClass: "DIRECT_SEARCH",
    costClass: "UNKNOWN",
    details: `Firecrawl Search uses a SecretBroker credential reference. Only bounded web search is requested. ${BYO_UNAVAILABLE}`,
    authSource: "secret_broker",
  },
  parallel: {
    title: "Parallel Search",
    routeClass: "DIRECT_SEARCH",
    costClass: "UNKNOWN",
    details: `Parallel Search uses a SecretBroker credential reference. Usage cost is unknown until current pricing is reviewed. ${BYO_UNAVAILABLE}`,
    authSource: "secret_broker",
  },
}

function configValue(value: unknown): ConfigResponse {
  if (typeof value !== "object" || value === null) return {}
  return value as ConfigResponse
}

export function DialogWebSearchSettings() {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [config, setConfig] = createSignal<ConfigResponse>()
  const [providerStatus, setProviderStatus] = createSignal<SearchProviderStatus[]>()
  const [busy, setBusy] = createSignal(false)
  const [selectedRoute, setSelectedRoute] = createSignal<SearchRouteID>("exa_keyless")
  const workspace = () => project.workspace.current()

  async function load() {
    try {
      const response = await sdk.client.config.get({ workspace: workspace() }, { throwOnError: true })
      setConfig(configValue(response.data))
    } catch (error) {
      toast.show({
        variant: "error",
        message: `Could not load web-search settings: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  async function loadProviderStatus() {
    try {
      const response = await sdk.client.webSearch.providers({ workspace: workspace() }, { throwOnError: true })
      setProviderStatus(response.data as SearchProviderStatus[])
    } catch {
      // Settings remain useful when a remote/older server has no status route.
      // Show status as unknown instead of claiming a credential is missing.
      setProviderStatus(undefined)
    }
  }

  onMount(() => {
    void load()
    void loadProviderStatus()
  })

  const settings = createMemo(() => normalizeSettings(config()?.websearch))

  async function toggle(id: SearchRouteID) {
    const enabling = !settings().enabled.includes(id)
    const isAnonymousRoute = id.endsWith("_keyless") || id === "youcom_free"
    let consent = false
    if (enabling && isAnonymousRoute) {
      if (!settings().querySharingConsent) {
        consent = await DialogConfirm.show(
          dialog,
          "Allow anonymous web search",
          "Search queries will be sent to Exa, You.com, Firecrawl, and Parallel as needed. These anonymous routes may have provider-side rate limits. This records consent and enables the four-route free cascade; dispatch remains unavailable until Guarded acceptance passes, and no paid route is enabled.",
          "Decline",
          { preservePrevious: true },
        ) ?? false
        if (!consent) return
      }
    } else if (enabling && ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS.includes(id as (typeof ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS)[number]) &&
      !settings().byoConsents?.some((entry) => entry.route === id && entry.consent === "secret_broker_unknown_cost_v1")) {
      consent = await DialogConfirm.show(
        dialog,
        `Enable ${ROUTE_INFO[id].title}`,
        `Search queries will be sent to ${ROUTE_INFO[id].title} using its SecretBroker credential. Current cost is UNKNOWN and usage may incur charges. This consent applies only to this route; it does not authorize other providers.`,
        "Decline",
        { preservePrevious: true },
      ) ?? false
      if (!consent) return
    }
    const current = settings()
    const firstAnonymousConsent = enabling && isAnonymousRoute && consent && !current.querySharingConsent
    const next = firstAnonymousConsent
      ? normalizeSettings({
          querySharingConsent: "anonymous_free_v1",
          byoConsents: current.byoConsents,
          enabled: [...new Set<SearchRouteID>(["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless", ...current.enabled])],
          order: [...new Set<SearchRouteID>(["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless", ...current.order])],
        })
      : setEnabled(current, id, enabling)
    await save(next)
  }

  async function revokeConsent(id: SearchRouteID) {
    const approved = await DialogConfirm.show(
      dialog,
      `Forget ${ROUTE_INFO[id].title} consent`,
      "This removes the stored route-specific auth/cost consent and disables this route. It will require a new explicit confirmation before it can be enabled again.",
      "Keep consent",
      { preservePrevious: true },
    ) ?? false
    if (!approved) return
    await save(revokeRouteConsent(settings(), id))
  }

  async function move(delta: -1 | 1) {
    const next = moveSearchRoute(settings(), selectedRoute(), delta)
    if (next.order.some((id, index) => id !== settings().order[index])) await save(next)
  }

  useBindings(() => ({
    bindings: [
      { key: "ctrl+left", desc: "Move search route earlier", group: "Web search", cmd: () => void move(-1) },
      { key: "ctrl+right", desc: "Move search route later", group: "Web search", cmd: () => void move(1) },
    ],
  }))
  const options = createMemo(() => {
    const current = settings()
    const displayed = [...current.order, ...SEARCH_ROUTE_IDS.filter((id) => !current.order.includes(id))]
    return displayed.flatMap((id) => {
      const info = ROUTE_INFO[id]
      const enabled = current.enabled.includes(id)
      const position = current.order.indexOf(id)
      const statusProjection = providerStatus()?.find((provider) => provider.provider === id)
      const attemptDetails = statusProjection
        ? [
            statusProjection.lastAttemptStatus ? `last=${statusProjection.lastAttemptStatus}` : undefined,
            statusProjection.lastStatusCode ? `http=${statusProjection.lastStatusCode}` : undefined,
            statusProjection.retryAfterMs !== undefined ? `retryAfterMs=${statusProjection.retryAfterMs}` : undefined,
            statusProjection.cooldownUntil ? `cooldownUntil=${statusProjection.cooldownUntil}` : undefined,
            statusProjection.lastError ? `lastFailure=${statusProjection.lastError}` : undefined,
          ].filter((value): value is string => !!value).join(" · ")
        : ""
      const status = !enabled
        ? "Disabled"
        : statusProjection
          ? `Enabled · route ${position + 1} · ${statusProjection.status} · configured=${statusProjection.configured ? "yes" : "no"} · cost=${statusProjection.costClass} · auth=${statusProjection.authSource} · fresh=${statusProjection.freshness}`
          : `Enabled · route ${position + 1} · provider status unavailable`
      const routeOption = {
        value: { kind: "route", route: id } satisfies SearchSettingsChoice,
        title: `${enabled ? "✓ " : "  "}${info.title}`,
        category: "Web search",
        description: `${info.details} Cost ${statusProjection?.costClass ?? info.costClass}; auth ${statusProjection?.authSource ?? info.authSource}; freshness ${statusProjection?.freshness ?? "unknown"}.${statusProjection?.unavailableReason ? ` ${statusProjection.unavailableReason}` : ""}${attemptDetails ? ` Last route evidence: ${attemptDetails}.` : ""}`,
        footer: enabled ? `${status} · provider health not probed` : status,
      } satisfies DialogSelectOption<SearchSettingsChoice>
      const revokeOption = ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS.includes(id as (typeof ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS)[number]) &&
        current.byoConsents?.some((entry) => entry.route === id)
        ? [{
            value: { kind: "revoke-consent", route: id } satisfies SearchSettingsChoice,
            title: `Forget saved consent · ${info.title}`,
            category: "Web search",
            description: "Remove this route’s stored auth/cost consent and disable the route.",
          } satisfies DialogSelectOption<SearchSettingsChoice>]
        : []
      return [routeOption, ...revokeOption]
    })
  })

  async function save(next: WebSearchConfig) {
    if (busy()) return
    setBusy(true)
    try {
      const latest = await sdk.client.config.get({ workspace: workspace() }, { throwOnError: true })
      const value = configValue(latest.data)
      const body = { ...value, websearch: next } as never
      const result = await sdk.client.config.update({ workspace: workspace(), config: body }, { throwOnError: true })
      setConfig(configValue(result.data))
      await loadProviderStatus()
      toast.show({ message: "Web-search settings saved.", variant: "info" })
    } catch (error) {
      toast.show({
        variant: "error",
        message: `Web-search settings were not saved: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogSelect<SearchSettingsChoice>
      title="Settings · Web search"
      options={options()}
      locked={busy()}
      onMove={(option) => {
        if (option.value.kind === "route") setSelectedRoute(option.value.route)
      }}
      onSelect={(option) => {
        if (option.value.kind === "route") void toggle(option.value.route)
        else void revokeConsent(option.value.route)
      }}
      footer={
        <box paddingTop={1}>
        <text fg={theme.textMuted}>First use asks before sending queries to the four anonymous providers; accepting enables their default cascade. Each BYO route has a separate consent prompt for SecretBroker use and possible charges. Enabled routes run in order; Ctrl+←/→ reorders. Cost and freshness are shown per route; provider health is not probed. Dispatch remains disabled until Guarded transport and SecretBroker acceptance pass.</text>
        </box>
      }
    />
  )
}
