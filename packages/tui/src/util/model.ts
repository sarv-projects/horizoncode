import type { Provider } from "@horizoncode/sdk/v2"

type PriceRates = {
  input?: number
  output?: number
  cache?: { read?: number; write?: number }
}

type Price = PriceRates & {
  tiers?: PriceRates[]
  experimentalOver200K?: PriceRates
}

export function hasConnectedProvider(providerIDs: readonly string[]) {
  return providerIDs.some((providerID) => providerID.trim().length > 0)
}

function hasExplicitZeroRates(rates: PriceRates) {
  return rates.input === 0 && rates.output === 0 && rates.cache?.read === 0 && rates.cache?.write === 0
}

export function explicitZeroPriceLabel(cost: Price | undefined) {
  if (!cost || !hasExplicitZeroRates(cost)) return undefined
  if (cost.tiers?.some((tier) => !hasExplicitZeroRates(tier))) return undefined
  if (cost.experimentalOver200K && !hasExplicitZeroRates(cost.experimentalOver200K)) return undefined
  return "Listed $0"
}

function isPriceRate(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function formatUsd(value: number) {
  const normalized = value === 0 ? 0 : value
  return `$${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(normalized)}`
}

export function modelPriceLabel(cost: Price | undefined) {
  const zeroPrice = explicitZeroPriceLabel(cost)
  if (zeroPrice) return zeroPrice
  if (!cost || !isPriceRate(cost.input) || !isPriceRate(cost.output)) return "Price unknown"

  // Zero token rates without complete secondary rates do not prove a zero-cost model.
  if (cost.input === 0 && cost.output === 0) return "Price unknown"

  return `${formatUsd(cost.input)} in / ${formatUsd(cost.output)} out per 1M`
}

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID)?.name ?? modelID
}
