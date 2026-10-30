/** Cached catalog projection from the retained OpenCode DigitalOcean adapter.
 * No plugin initialization, token refresh, credential mutation or network access.
 */
import { ModelV2 } from "@horizoncode/core/model"
import { ProviderV2 } from "@horizoncode/core/provider"
import type { Model } from "./provider"

export function cachedDigitalOceanRouters(metadata: Record<string, string> | undefined): Model[] {
  const raw = metadata?.routers
  if (!raw || raw.length > 65_536) return []
  let decoded: unknown
  try { decoded = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(decoded) || decoded.length > 128) return []
  const seen = new Set<string>()
  return decoded.flatMap((router): Model[] => {
    if (typeof router !== "object" || router === null || typeof router.name !== "string") return []
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(router.name) || seen.has(router.name)) return []
    seen.add(router.name)
    const id = ModelV2.ID.make(`router:${router.name}`)
    return [{
      id, providerID: ProviderV2.ID.make("digitalocean"), name: router.name,
      family: "digitalocean-inference-routers",
      api: { id, url: "https://inference.do-ai.run/v1", npm: "@ai-sdk/openai-compatible" },
      status: "active", headers: {}, options: {},
      // A cached route's underlying model and price are unknown. The upstream
      // plugin's zero rates are not evidence of a free entitlement.
      cost: { cache: {} }, limit: { context: 0, output: 0 },
      capabilities: {
        temperature: true, reasoning: false, attachment: false, toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "", variants: {},
    }]
  })
}
