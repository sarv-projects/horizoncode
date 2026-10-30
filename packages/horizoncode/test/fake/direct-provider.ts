import { Effect, Layer } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createCerebras } from "@ai-sdk/cerebras"
import { createAlibaba } from "@ai-sdk/alibaba"
import type { DirectProviderRouteV1 } from "@/auth/provider-transport"
import { Provider } from "@/provider/provider"

/**
 * Typed direct-transport double at the Provider seam.
 *
 * `LLM.run` resolves every turn through `Provider.getDirectLanguage`; production
 * admits only the exact anonymous OpenCode offer there (see
 * `Provider.isAnonymousFreeModel`). The streaming suite deliberately exercises
 * vendor-specific payload shaping, which is keyed on `model.providerID` and
 * `model.api.npm`, so it must keep each vendor identity instead of collapsing
 * every case onto the one admitted `opencode` catalog entry.
 *
 * This double therefore keeps the real registry (config-loaded providers and
 * their models, list/getModel/getProvider, credential projection, managed
 * routes) and replaces only the transport construction: it builds the same
 * bundled adapter the direct lane would build, pointed at the model's configured
 * endpoint. No production check is weakened and no external route is
 * contacted; the anonymous-offer admission rule itself stays covered by
 * `test/session/llm-credential-gate.test.ts`, `test/provider/credential-cost.test.ts`
 * and `test/provider/opencode-free.test.ts`.
 */
type BundledFactory = (options: Record<string, unknown>) => { languageModel: (id: string) => unknown }

const FACTORIES: Readonly<Record<string, BundledFactory>> = {
  "@ai-sdk/openai": createOpenAI as unknown as BundledFactory,
  "@ai-sdk/openai-compatible": createOpenAICompatible as unknown as BundledFactory,
  "@ai-sdk/anthropic": createAnthropic as unknown as BundledFactory,
  "@ai-sdk/google": createGoogleGenerativeAI as unknown as BundledFactory,
  "@ai-sdk/mistral": createMistral as unknown as BundledFactory,
  "@ai-sdk/cerebras": createCerebras as unknown as BundledFactory,
  "@ai-sdk/alibaba": createAlibaba as unknown as BundledFactory,
}

export function directTestRoute(input: {
  providerID: string
  modelID: string
  harnessID: string
  endpointBase: string
}): DirectProviderRouteV1 {
  const routeID = `llm_${input.providerID}_${input.modelID}_direct_test`
  // Annotated so the credential-header literals narrow to the route's fixed
  // header union instead of widening to `string`.
  const route: DirectProviderRouteV1 = {
    providerID: input.providerID,
    modelID: input.modelID,
    harnessID: input.harnessID,
    routeID,
    routeRevision: routeID,
    endpointRevision: `blake3:${"0".repeat(64)}`,
    endpointBase: input.endpointBase,
    anonymousOpenCodeFree: false,
    credentialHeader: { name: "authorization", prefix: "Bearer " },
  }
  return Object.freeze(route)
}

const double = Layer.effect(Provider.Service)(
  Effect.gen(function* () {
    const real = yield* Provider.Service
    return Provider.Service.of({
      ...real,
      getDirectLanguage: Effect.fn("TestDirectProvider.getDirectLanguage")(function* (input: {
        model: Provider.Model
        harnessID: string
        fetch: typeof fetch
      }) {
        const info = yield* real.getProvider(input.model.providerID)
        const options = info.options as Record<string, unknown>
        const configured = typeof options.baseURL === "string" && options.baseURL.length > 0 ? options.baseURL : undefined
        const endpointBase = configured ?? input.model.api.url
        const factory = FACTORIES[input.model.api.npm]
        if (!factory) return yield* Effect.die(new Error(`No bundled adapter fixture for ${input.model.api.npm}`))
        // Pass the provider projection through unchanged (including the empty
        // apiKey the streaming fixtures assert on): only the endpoint the
        // request is sent to is pinned at the local test server.
        const { baseURL: _baseURL, ...rest } = options
        const sdk = factory({
          name: input.model.providerID,
          ...rest,
          ...input.model.options,
          baseURL: endpointBase,
          fetch: input.fetch,
        })
        return {
          language: sdk.languageModel(input.model.api.id) as never,
          route: directTestRoute({
            providerID: input.model.providerID,
            modelID: input.model.id,
            harnessID: input.harnessID,
            endpointBase,
          }),
        }
      }),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(Provider.node)))

/**
 * Replacement node for `Provider.node` in the LayerNode graph. It reuses the
 * real provider layer from the same graph dependencies, so model resolution,
 * credential projection and managed-route behaviour are unchanged.
 */
export const directProviderNode = LayerNode.make({
  service: Provider.Service,
  layer: double,
  // `Node.dependencies` is exposed as a plain array; the graph contract needs a
  // non-empty tuple. `Provider.node` always declares at least one dependency.
  deps: Provider.node.dependencies as unknown as readonly [
    (typeof Provider.node.dependencies)[number],
    ...(typeof Provider.node.dependencies)[number][],
  ],
  tag: Provider.node.tag,
})