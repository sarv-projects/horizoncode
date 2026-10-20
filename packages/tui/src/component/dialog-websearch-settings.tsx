import { createMemo, createSignal, onMount } from "solid-js"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"

const SEARCH_ROUTE_IDS = ConfigV1.WEB_SEARCH_ROUTE_IDS
type SearchRouteID = NonNullable<NonNullable<ConfigV1.Info["websearch"]>["enabled"]>[number]
type SearchRouteClass = "DIRECT_SEARCH" | "GROUNDED_MODEL_SEARCH"
type SearchCostClass = "FREE" | "PAID" | "TRIAL" | "UNKNOWN"
type SearchAuthSource = "none" | "saved_credential" | "secret_broker" | "environment" | "model_provider" | "unknown"
type WebSearchConfig = { enabled?: SearchRouteID[]; order?: SearchRouteID[] }
type ConfigResponse = { websearch?: WebSearchConfig; [key: string]: unknown }
const BYO_UNAVAILABLE = "Enable records consent and adds this route to the cascade. It stays unavailable until a SecretBroker credential and Guarded transport are available."

function normalizeSettings(input?: WebSearchConfig) {
  const allowed = SEARCH_ROUTE_IDS as readonly SearchRouteID[]
  const enabled = [...new Set(input?.enabled ?? ["exa_keyless", "youcom_free", "tavily_keyless", "firecrawl_keyless", "parallel_keyless"] as SearchRouteID[])].filter((id) => allowed.includes(id))
  const requestedOrder = [...new Set(input?.order ?? SEARCH_ROUTE_IDS)].filter((id) => allowed.includes(id))
  const order = [...requestedOrder.filter((id) => enabled.includes(id)), ...enabled.filter((id) => !requestedOrder.includes(id))]
  return { enabled, order }
}

function setEnabled(input: WebSearchConfig | undefined, id: SearchRouteID, enabled: boolean) {
  const current = normalizeSettings(input)
  return normalizeSettings({
    enabled: enabled ? [...current.enabled, id] : current.enabled.filter((value) => value !== id),
    order: enabled ? [...current.order, id] : current.order.filter((value) => value !== id),
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
    details: "Built-in keyless MCP route. Search remains unavailable until Guard acceptance.",
  },
  youcom_free: {
    title: "Built-in default · You.com",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Built-in free MCP route. Search remains unavailable until Guard acceptance.",
  },
  tavily_keyless: {
    title: "Built-in default · Tavily",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Built-in no-key MCP route with a provider rate limit. Search remains unavailable until Guard acceptance.",
  },
  firecrawl_keyless: {
    title: "Built-in default · Firecrawl",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Built-in keyless MCP route. Search remains unavailable until Guard acceptance.",
  },
  parallel_keyless: {
    title: "Built-in default · Parallel",
    routeClass: "DIRECT_SEARCH",
    costClass: "FREE",
    authSource: "none",
    details: "Built-in no-key MCP route with anonymous rate limits. Search remains unavailable until Guard acceptance.",
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
  const [config, setConfig] = createSignal<ConfigResponse>()
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

  onMount(() => void load())

  const settings = createMemo(() => normalizeSettings(config()?.websearch))

  async function toggle(id: SearchRouteID) {
    const next = setEnabled(settings(), id, !settings().enabled.includes(id))
    await save(next)
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
    return displayed.map((id) => {
      const info = ROUTE_INFO[id]
      const enabled = current.enabled.includes(id)
      const position = current.order.indexOf(id)
      const status = !enabled
        ? "Disabled"
        : id !== "exa_keyless" && id !== "youcom_free" && id !== "tavily_keyless" && id !== "firecrawl_keyless" && id !== "parallel_keyless"
          ? `Enabled · route ${position + 1} · unconfigured (no SecretBroker ref)`
          : `Enabled · route ${position + 1}`
      return {
        value: id,
        title: `${enabled ? "✓ " : "  "}${info.title}`,
        category: "Web search",
        description: `${info.details} Cost ${info.costClass}; auth ${info.authSource}.`,
        footer: enabled ? `${status} · ${position + 1}/${current.enabled.length}` : status,
        onSelect: () => void toggle(id),
      } satisfies DialogSelectOption<SearchRouteID>
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
    <DialogSelect
      title="Settings · Web search"
      options={options()}
      locked={busy()}
      onMove={(option) => setSelectedRoute(option.value)}
      onSelect={(option) => setSelectedRoute(option.value)}
      footer={
        <box paddingTop={1}>
        <text fg={theme.textMuted}>Enter toggles a route. Enabled routes run in order; Ctrl+←/→ reorders. BYO routes remain unavailable until SecretBroker and Guarded HTTP are connected.</text>
        </box>
      }
    />
  )
}
