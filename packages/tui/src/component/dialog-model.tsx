import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { explicitZeroPriceLabel, modelPriceLabel } from "../util/model"
import { DialogProviderDoctor } from "./dialog-provider-doctor"

type ListedModelCapabilities = {
  toolcall?: boolean
  reasoning?: boolean
  input?: { image?: boolean; audio?: boolean; video?: boolean; pdf?: boolean }
  output?: { image?: boolean; audio?: boolean; video?: boolean; pdf?: boolean }
}

/** Catalog capability hints and connection state; this is not a live endpoint probe. */
export function modelAvailabilityLabel(input: {
  connected: boolean
  status?: "active" | "alpha" | "beta" | "deprecated"
  capabilities?: ListedModelCapabilities
}) {
  const labels = [
    input.connected ? "Provider available" : "Provider unavailable",
    `Catalog ${input.status ?? "status unknown"}`,
  ]
  const capabilities = input.capabilities
  const listed = [
    capabilities?.toolcall ? "tools" : undefined,
    capabilities?.reasoning ? "reasoning" : undefined,
    capabilities?.input?.image ? "image input" : undefined,
    capabilities?.input?.audio ? "audio input" : undefined,
    capabilities?.input?.video ? "video input" : undefined,
    capabilities?.input?.pdf ? "PDF input" : undefined,
    capabilities?.output?.image ? "image output" : undefined,
    capabilities?.output?.audio ? "audio output" : undefined,
    capabilities?.output?.video ? "video output" : undefined,
    capabilities?.output?.pdf ? "PDF output" : undefined,
  ].filter((value): value is string => value !== undefined)
  if (listed.length > 0) labels.push(`Listed support: ${listed.join(", ")}`)
  return labels.join(" · ")
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)
  const agentModel = createMemo(() => local.agent.current()?.model)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: `${modelPriceLabel(model.cost)} · ${modelAvailabilityLabel({
              connected: sync.data.provider_next.connected.includes(provider.id),
              status: model.status,
              capabilities: model.capabilities,
            })}`,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description:
              [
                favorites.some((item) => item.providerID === provider.id && item.modelID === model)
                  ? "(Favorite)"
                  : undefined,
                agentModel()?.providerID === provider.id && agentModel()?.modelID === model
                  ? "(Agent default)"
                  : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: `${modelPriceLabel(info.cost)} · ${modelAvailabilityLabel({
              connected: sync.data.provider_next.connected.includes(provider.id),
              status: info.status,
              capabilities: info.capabilities,
            })}`,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
          false,
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "provider.doctor.offline",
          title: "Provider Doctor · Offline",
          onTrigger() {
            dialog.replace(() => <DialogProviderDoctor />)
          },
        },
        {
          command: "model.dialog.provider",
          title: connected() ? "Switch provider/model" : "View providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

type ModelPriceRates = {
  input?: number
  output?: number
  cache?: { read?: number; write?: number }
}

type ModelCostShape = ModelPriceRates & {
  tiers?: ModelPriceRates[]
  experimentalOver200K?: ModelPriceRates
}

/**
 * Pricing is only known to be zero when every listed rate is explicitly zero.
 * Missing components are unknown, not a free-price claim.
 */
export function isZeroPricedModel(model: { cost?: ModelCostShape }) {
  return explicitZeroPriceLabel(model.cost) !== undefined
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free" && option.footer !== "Listed $0",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
