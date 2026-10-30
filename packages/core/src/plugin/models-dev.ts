import { define } from "./internal"
import type { ModelV2Info } from "@horizoncode/sdk/v2/types"
import { Effect, Stream } from "effect"
import { EventV2 } from "../event"
import { ModelsDev } from "../models-dev"
import { ProviderV2 } from "../provider"

function released(date: string) {
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : 0
}

function cost(input: ModelsDev.Model["cost"]): ModelV2Info["cost"] {
  if (!input) return []

  const priced = (item: { input: number; output: number; cache_read?: number; cache_write?: number }) => {
    if (item.cache_read === undefined || item.cache_write === undefined) return undefined
    return {
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read,
        write: item.cache_write,
      },
    }
  }

  const base = priced(input)
  const tiers = input.tiers?.flatMap((item) => {
    const price = priced(item)
    return price ? [{ ...price, tier: item.tier }] : []
  }) ?? []
  const contextOver = input.context_over_200k ? priced(input.context_over_200k) : undefined

  // The SDK cost shape cannot encode partial/unknown rates. An empty schedule
  // keeps those prices UNKNOWN instead of inventing a zero-priced offer.
  if (!base || tiers.length !== (input.tiers ? input.tiers.length : 0) || (input.context_over_200k !== undefined && !contextOver)) {
    return []
  }

  return [
    base,
    ...tiers,
    ...(contextOver
      ? [
          {
            ...contextOver,
            tier: {
              type: "context" as const,
              size: 200_000,
            },
          },
        ]
      : []),
  ]
}

function mergeCost(base: ModelV2Info["cost"], override: ModelsDev.Model["cost"] | undefined) {
  if (!override) return base
  const next = cost(override)
  if (next.length === 0) return []
  if (base.length === 0) return next

  const [baseDefault, ...baseTiers] = base
  const [nextDefault, ...nextTiers] = next
  if (!baseDefault || !nextDefault) return []
  const tierKey = (item: ModelV2Info["cost"][number]) => `${item.tier ? item.tier.type : "base"}:${item.tier ? item.tier.size : 0}`
  const merge = (left: ModelV2Info["cost"][number], right: ModelV2Info["cost"][number]) => ({
    ...left,
    ...right,
    tier: right.tier ?? left.tier,
    cache: { ...left.cache, ...right.cache },
  })
  const tiers = new Map(baseTiers.map((item) => [tierKey(item), item]))
  for (const item of nextTiers) {
    const current = tiers.get(tierKey(item))
    tiers.set(tierKey(item), current ? merge(current, item) : item)
  }
  return [merge(baseDefault, nextDefault), ...tiers.values()]
}

function modeName(model: ModelsDev.Model, mode: string) {
  return `${model.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
}

function applyModel(
  draft: ModelV2Info,
  model: ModelsDev.Model,
  input: {
    readonly name?: string
    readonly cost?: ModelV2Info["cost"]
    readonly request?: NonNullable<NonNullable<ModelsDev.Model["experimental"]>["modes"]>[string]["provider"]
  } = {},
) {
  draft.name = input.name ?? model.name
  draft.family = model.family
  draft.api = model.provider?.npm
    ? {
        id: model.id,
        type: "aisdk",
        package: model.provider.npm,
        url: model.provider.api,
      }
    : {
        id: model.id,
        type: "native",
        url: model.provider?.api,
        settings: {},
      }
  draft.capabilities = {
    tools: model.tool_call,
    input: [...(model.modalities?.input ?? [])],
    output: [...(model.modalities?.output ?? [])],
  }
  draft.variants = []
  draft.time.released = released(model.release_date)
  draft.cost = input.cost ?? cost(model.cost)
  draft.status = model.status ?? "active"
  draft.enabled = true
  draft.limit = {
    context: model.limit.context,
    input: model.limit.input,
    output: model.limit.output,
  }
  Object.assign(draft.request.headers, input.request?.headers ?? {})
  Object.assign(draft.request.body, input.request?.body ?? {})
}

export const ModelsDevPlugin = define({
  id: "models-dev",
  effect: Effect.fn(function* (ctx) {
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const data = yield* modelsDev.get()
        for (const item of Object.values(data)) {
          if (item.env.length === 0) continue
          const integrationID = item.id
          integrations.update(integrationID, (integration) => (integration.name = item.name))
          integrations.method.update({
            integrationID,
            method: { type: "key" },
          })
          integrations.method.update({
            integrationID,
            method: { type: "env", names: [...item.env] },
          })
        }
      }),
    )
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const data = yield* modelsDev.get()
        for (const item of Object.values(data)) {
          const providerID = ProviderV2.ID.make(item.id)
          catalog.provider.update(providerID, (provider) => {
            provider.name = item.name
            provider.api = item.npm
              ? {
                  type: "aisdk",
                  package: item.npm,
                  url: item.api,
                }
              : {
                  type: "native",
                  url: item.api,
                  settings: {},
                }
          })

          for (const model of Object.values(item.models)) {
            const baseCost = cost(model.cost)
            catalog.model.update(providerID, model.id, (draft) => applyModel(draft, model, { cost: baseCost }))
            for (const [mode, options] of Object.entries(model.experimental?.modes ?? {})) {
              catalog.model.update(providerID, `${model.id}-${mode}`, (draft) =>
                applyModel(draft, model, {
                  name: modeName(model, mode),
                  cost: mergeCost(baseCost, options.cost),
                  request: options.provider,
                }),
              )
            }
          }
        }
      }),
    )
    yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() => ctx.integration.reload().pipe(Effect.andThen(ctx.catalog.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )
    // One bounded metadata refresh attempt per process start (A-V2-27 amendment, SRC-028).
    // A cache inside the freshness window short-circuits, offline/fetch failure keeps the last
    // known-good snapshot, and a completed fetch publishes Refreshed for the subscriber above.
    yield* modelsDev.refresh(true).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})
