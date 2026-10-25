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

type ListedModelLimits = {
  context?: number
  input?: number
  output?: number
}

const tokenLimitFormatter = new Intl.NumberFormat("en-US")

export function catalogProvenanceLabel(snapshot: {
  source: string
  freshness: string
  sourceURL?: string
  retrievedAt?: number
  contentDigest?: string
  license?: string
  attribution?: string
}) {
  const parts = [`Catalog ${snapshot.source}/${snapshot.freshness}`]
  if (snapshot.sourceURL) parts.push(snapshot.sourceURL)
  if (snapshot.retrievedAt !== undefined) parts.push(`retrieved ${new Date(snapshot.retrievedAt).toISOString()}`)
  if (snapshot.contentDigest) parts.push(`digest ${snapshot.contentDigest.slice(0, 12)}`)
  if (snapshot.license) parts.push(`license ${snapshot.license}`)
  if (snapshot.attribution) parts.push(snapshot.attribution)
  return parts.join(" · ")
}

function tokenLimit(value: number | undefined) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? tokenLimitFormatter.format(value)
    : "unknown"
}

function support(value: boolean | undefined) {
  return value === undefined ? "unknown" : value ? "yes" : "no"
}

/** Catalog capability hints and connection state; this is not a live endpoint probe. */
export function modelAvailabilityLabel(input: {
  providerID?: string
  connected: boolean
  source?: string
  anonymousOffer?: boolean
  status?: "active" | "alpha" | "beta" | "deprecated"
  cost?: ModelCostShape
  capabilities?: ListedModelCapabilities
  limits?: ListedModelLimits
}) {
  const labels = [
    input.providerID === "opencode" && input.anonymousOffer
      ? "Anonymous OpenCode offer · zero-priced catalog only"
      : input.connected
        ? input.source === "env"
          ? "Legacy environment source detected · not used for dispatch"
          : input.source === "api"
            ? "Legacy Auth source detected · not used for dispatch"
            : input.source === "config"
              ? "Provider configuration present · credential status unknown"
              : "Credential reference or provider configuration present · dispatch unavailable pending SecretBroker transport"
        : "No Guarded credential reference or anonymous route detected",
    `Catalog ${input.status ?? "status unknown"}`,
    "Endpoint not probed",
    modelSelectableInV1({
      providerID: input.providerID ?? "",
      credentialSourceDetected: input.connected,
      anonymousOffer: input.anonymousOffer,
      status: input.status,
      cost: input.cost,
    }) ? "Selectable by HorizonCode V1 policy; dispatch unverified" : "Dispatch unavailable in HorizonCode V1",
  ]
  labels.push(
    `Catalog limits: context ${tokenLimit(input.limits?.context)} · input ${tokenLimit(input.limits?.input)} · output ${tokenLimit(input.limits?.output)}`,
  )
  labels.push("Price freshness unknown")
  const capabilities = input.capabilities
  labels.push(
    `Capabilities: tools ${support(capabilities?.toolcall)} · reasoning ${support(capabilities?.reasoning)} · image-in ${support(capabilities?.input?.image)} · audio-in ${support(capabilities?.input?.audio)} · video-in ${support(capabilities?.input?.video)} · pdf-in ${support(capabilities?.input?.pdf)} · image-out ${support(capabilities?.output?.image)} · audio-out ${support(capabilities?.output?.audio)} · video-out ${support(capabilities?.output?.video)} · pdf-out ${support(capabilities?.output?.pdf)}`,
  )
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
            disabled: !modelSelectableInV1({
              providerID: provider.id,
              credentialSourceDetected: sync.data.provider_next.connected.includes(provider.id),
              anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model.id}`),
              status: model.status,
              cost: model.cost,
            }),
            footer: `${modelPriceLabel(model.cost)} · ${modelAvailabilityLabel({
              providerID: provider.id,
              connected: sync.data.provider_next.connected.includes(provider.id),
              source: provider.source,
              anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model.id}`),
              status: model.status,
              cost: model.cost,
              capabilities: model.capabilities,
              limits: model.limit,
            })} · ${catalogProvenanceLabel(sync.data.provider_next.catalogSnapshot)}`,
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
            disabled: !modelSelectableInV1({
              providerID: provider.id,
              credentialSourceDetected: sync.data.provider_next.connected.includes(provider.id),
              anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model}`),
              status: info.status,
              cost: info.cost,
            }),
            footer: `${modelPriceLabel(info.cost)} · ${modelAvailabilityLabel({
              providerID: provider.id,
              connected: sync.data.provider_next.connected.includes(provider.id),
              source: provider.source,
              anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model}`),
              status: info.status,
              cost: info.cost,
              capabilities: info.capabilities,
              limits: info.limit,
            })} · ${catalogProvenanceLabel(sync.data.provider_next.catalogSnapshot)}`,
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

/** V1 dispatch currently supports only the anonymous, fully zero-priced offer. */
export function modelSelectableInV1(input: {
  providerID: string
  credentialSourceDetected: boolean
  anonymousOffer?: boolean
  status?: "active" | "alpha" | "beta" | "deprecated"
  cost?: ModelCostShape
}) {
  return input.providerID === "opencode" &&
    input.anonymousOffer === true &&
    input.status === "active" &&
    isZeroPricedModel({ cost: input.cost })
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
