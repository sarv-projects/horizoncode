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

/** The largest millisecond instant `Date` can represent; anything beyond it is not a usable retrieval time. */
const MAX_DATE_MS = 8_640_000_000_000_000

function provenanceText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/**
 * Advisory catalog provenance for the model dialog. This is not endpoint
 * health and grants no route authority.
 *
 * The contract for a missing snapshot — or a missing field on it — is
 * *unknown, never current*: the label must not throw inside the dialog, must
 * not invent a source or freshness, and must not fall back to a success-looking
 * default. Only values the server actually sent are rendered.
 */
export function catalogProvenanceLabel(snapshot: {
  source?: string
  freshness?: string
  sourceURL?: string
  retrievedAt?: number
  contentDigest?: string
  license?: string
  attribution?: string
} | undefined | null) {
  if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") {
    return "Catalog provenance unknown"
  }
  const source = provenanceText(snapshot.source)
  const freshness = provenanceText(snapshot.freshness)
  if (source === undefined && freshness === undefined) return "Catalog provenance unknown"

  const parts = [`Catalog ${source ?? "unknown"}/${freshness ?? "unknown"}`]
  const sourceURL = provenanceText(snapshot.sourceURL)
  if (sourceURL) parts.push(sourceURL)
  const retrievedAt =
    typeof snapshot.retrievedAt === "number" &&
    Number.isFinite(snapshot.retrievedAt) &&
    snapshot.retrievedAt >= 0 &&
    snapshot.retrievedAt <= MAX_DATE_MS
      ? snapshot.retrievedAt
      : undefined
  if (retrievedAt !== undefined) parts.push(`retrieved ${new Date(retrievedAt).toISOString()}`)
  const contentDigest = provenanceText(snapshot.contentDigest)
  if (contentDigest) parts.push(`digest ${contentDigest.slice(0, 12)}`)
  const license = provenanceText(snapshot.license)
  if (license) parts.push(`license ${license}`)
  const attribution = provenanceText(snapshot.attribution)
  if (attribution) parts.push(attribution)
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
  localDirectCredentials?: boolean
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
    modelDispatchVerdictV1(input),
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
  const localDirect = createMemo(() => sync.data.provider_next.localDirectCredentials === true)
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
            disabled: !modelListedInV1({
              cost: model.cost,
              anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model.id}`),
            }),
            footer: modelPriceLabel(model.cost),
            details: modelRowDetails(
              {
                providerID: provider.id,
                connected: sync.data.provider_next.connected.includes(provider.id),
                localDirectCredentials: localDirect(),
                source: provider.source,
                anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model.id}`),
                status: model.status,
                cost: model.cost,
                capabilities: model.capabilities,
                limits: model.limit,
              },
              sync.data.provider_next.catalogSnapshot,
            ),
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
            disabled: !modelListedInV1({
              cost: info.cost,
              anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model}`),
            }),
            footer: modelPriceLabel(info.cost),
            details: modelRowDetails(
              {
                providerID: provider.id,
                connected: sync.data.provider_next.connected.includes(provider.id),
                localDirectCredentials: localDirect(),
                source: provider.source,
                anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${provider.id}/${model}`),
                status: info.status,
                cost: info.cost,
                capabilities: info.capabilities,
                limits: info.limit,
              },
              sync.data.provider_next.catalogSnapshot,
            ),
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
    // A listed row can still be unavailable: choosing one must never change the
    // selected model or start an auth flow (arch_V1/16 provider/model hub).
    // Fail closed when the projection itself is missing.
    const model = sync.data.provider.find((item) => item.id === providerID)?.models[modelID]
    const selectable = modelSelectableInV1({
      providerID,
      credentialSourceDetected: sync.data.provider_next.connected.includes(providerID),
      localDirectCredentials: localDirect(),
      anonymousOffer: sync.data.provider_next.anonymousFreeModels?.includes(`${providerID}/${modelID}`),
      status: model?.status,
      cost: model?.cost,
    })
    if (!model || !selectable) return
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

/** V1 production default: anonymous OpenCode only. Local audited direct credentials unlock any connected catalog route. */
export function modelSelectableInV1(input: {
  providerID: string
  credentialSourceDetected: boolean
  localDirectCredentials?: boolean
  anonymousOffer?: boolean
  status?: "active" | "alpha" | "beta" | "deprecated"
  cost?: ModelCostShape
}) {
  const opencodeAnonymous =
    input.providerID === "opencode" &&
    input.anonymousOffer === true &&
    input.status === "active" &&
    isZeroPricedModel({ cost: input.cost })
  if (opencodeAnonymous) return true
  if (input.localDirectCredentials && input.credentialSourceDetected && input.status === "active") return true
  return false
}

/**
 * What the model picker *lists* (arch_V1/16 provider/model hub): incomplete or
 * paid pricing, credential-backed and non-OpenCode models stay visible so their
 * price and "Dispatch unavailable in HorizonCode V1" status remain readable —
 * visibility never implies selectability, which stays with `modelSelectableInV1`.
 *
 * The single exception is a catalog `$0` entry the server has not declared as
 * its anonymous offer: "Listed $0" beside "dispatch unavailable" advertises
 * free access that does not exist, so such an entry is not listed at all.
 */
export function modelListedInV1(input: { cost?: ModelCostShape; anonymousOffer?: boolean }) {
  if (explicitZeroPriceLabel(input.cost) === undefined) return true
  return input.anonymousOffer === true
}

/** The availability answer the picker exists to give; always the first detail line of a model row. */
export function modelDispatchVerdictV1(input: {
  providerID?: string
  connected: boolean
  localDirectCredentials?: boolean
  anonymousOffer?: boolean
  status?: "active" | "alpha" | "beta" | "deprecated"
  cost?: ModelCostShape
}) {
  return modelSelectableInV1({
    providerID: input.providerID ?? "",
    credentialSourceDetected: input.connected,
    localDirectCredentials: input.localDirectCredentials,
    anonymousOffer: input.anonymousOffer,
    status: input.status,
    cost: input.cost,
  })
    ? input.localDirectCredentials && input.providerID !== "opencode"
      ? "Selectable with local credentials; dispatch unverified"
      : "Selectable by HorizonCode V1 policy; dispatch unverified"
    : "Dispatch unavailable in HorizonCode V1"
}

/**
 * A model row is one line wide: `title` sits beside a short price badge in
 * `footer`, and the long availability/provenance sentence lives on the
 * budgeted detail lines below it. Putting it in `footer` instead makes that
 * box wrap, and a wrapped footer is not counted by dialog-select's row budget —
 * the scroll area then fills with the first row and every later model falls
 * out of view.
 */
function modelRowDetails(
  availability: Parameters<typeof modelAvailabilityLabel>[0],
  catalogSnapshot: Parameters<typeof catalogProvenanceLabel>[0],
): string[] {
  return [
    modelDispatchVerdictV1(availability),
    `${modelAvailabilityLabel(availability)} · ${catalogProvenanceLabel(catalogSnapshot)}`,
  ]
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
