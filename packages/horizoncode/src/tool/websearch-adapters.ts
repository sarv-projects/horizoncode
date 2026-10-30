/** Provider-specific wire adapters for the HorizonCode web-search cascade.
 *
 * This module intentionally has no fetch implementation. It only builds fixed
 * route plans and parses bounded responses. Network and secret authority belong
 * to Guard/ExecutionHost and SecretBroker; runtime dispatch stays independently
 * disabled until those owners' integrated acceptance passes.
 */
import type { SearchRoute, SearchRouteID, SearchResultItem } from "./websearch-broker"
import type { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"

export type BYOSearchProviderID = "brave" | "exa" | "youcom" | "tavily" | "firecrawl" | "parallel"
export type SearchCredentialRefs = Partial<Record<BYOSearchProviderID, SecretBrokerV1.SecretRef>>

// Bound work spent decoding an MCP wrapper independently from the provider
// response body's HostKernel transport bound. The payload has already been
// parsed by the trusted transport, but its arrays and text fields are still
// untrusted input to this adapter.
const MAX_MCP_CONTENT_BLOCKS = 32
const MAX_MCP_TEXT_CHARS = 128 * 1024

export const KEYLESS_SEARCH_PROVIDERS = Object.freeze({
  duckduckgo: {
    label: "Built-in default · DuckDuckGo",
  },
  exa_keyless: {
    label: "Built-in default · Exa",
  },
  youcom_free: {
    label: "Built-in default · You.com",
  },
  firecrawl_keyless: {
    label: "Built-in default · Firecrawl",
  },
  parallel_keyless: {
    label: "Built-in default · Parallel",
  },
} as const)

export type KeylessSearchProviderID = keyof typeof KEYLESS_SEARCH_PROVIDERS

export const BYO_SEARCH_PROVIDERS = Object.freeze({
  brave: { label: "Brave Search", costClass: "UNKNOWN", authSource: "secret_broker" },
  exa: { label: "Exa Web Search", costClass: "UNKNOWN", authSource: "secret_broker" },
  youcom: { label: "You.com Search", costClass: "UNKNOWN", authSource: "secret_broker" },
  tavily: { label: "Tavily Search", costClass: "UNKNOWN", authSource: "secret_broker" },
  firecrawl: { label: "Firecrawl Search", costClass: "UNKNOWN", authSource: "secret_broker" },
  parallel: { label: "Parallel Search", costClass: "UNKNOWN", authSource: "secret_broker" },
} as const)

/** Fixed route plan for one aggregate HostKernel admission. */
export function createSearchRoutePlan(input: {
  enabled: readonly SearchRouteID[]
  order: readonly SearchRouteID[]
  supportedProviders: readonly SearchRouteID[]
  credentialRefs: SearchCredentialRefs
}) {
  const enabled = new Set(input.enabled)
  const supported = new Set(input.supportedProviders)
  const order = [...new Set([...input.order, ...input.enabled])].filter((route) => enabled.has(route) && supported.has(route))
  const routes = order.filter((route) => {
    if (route in KEYLESS_SEARCH_PROVIDERS) return true
    return route in BYO_SEARCH_PROVIDERS && input.credentialRefs[route as BYOSearchProviderID] !== undefined
  })
  const credentialRefsByRoute = routes.flatMap((routeKey) => {
    const secretRef = input.credentialRefs[routeKey as BYOSearchProviderID]
    return secretRef ? [{ routeKey, secretRef }] : []
  })
  return {
    routes,
    credentialRefsByRoute,
    provenance: routes.map((route) => ({
      provider: route,
      label: route in KEYLESS_SEARCH_PROVIDERS
        ? KEYLESS_SEARCH_PROVIDERS[route as KeylessSearchProviderID].label
        : BYO_SEARCH_PROVIDERS[route as BYOSearchProviderID].label,
      costClass: route in KEYLESS_SEARCH_PROVIDERS ? "FREE" as const : "UNKNOWN" as const,
      authSource: route in KEYLESS_SEARCH_PROVIDERS ? "none" as const : "secret_broker" as const,
    })),
  }
}

/**
 * Metadata-only route projection for Settings and inspect_provider. Unlike an
 * executable plan it includes disabled-but-configured routes, while BYO routes
 * without a SecretBroker reference remain absent. The stub can never send.
 */
export function createSearchInspectionRoutes(input: {
  supportedProviders: readonly SearchRouteID[]
  credentialRefs: SearchCredentialRefs
}): SearchRoute[] {
  const supported = [...new Set(input.supportedProviders)]
  const plan = createSearchRoutePlan({
    enabled: supported,
    order: supported,
    supportedProviders: supported,
    credentialRefs: input.credentialRefs,
  })
  return plan.provenance.map((route) => ({
    id: route.provider,
    label: route.label,
    routeClass: "DIRECT_SEARCH" as const,
    costClass: route.costClass,
    authSource: route.authSource,
    configured: true,
  }))
}

/**
 * Collapse a keyless route id onto the provider shape its response adapter
 * decodes. `exa_keyless` carries Exa's payload, `firecrawl_keyless` carries
 * Firecrawl's, and `youcom_free` carries You.com's, so comparing the raw route
 * id against the BYO ids silently disabled every provider-specific branch.
 */
function providerShape(provider: SearchRouteID) {
  return provider === "youcom_free" ? "youcom" : provider.replace(/_keyless$/, "")
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

function url(value: unknown) {
  if (typeof value !== "string") return
  const raw = value.trim()
  // Never turn an overlong provider URL into a different, clickable URL by
  // slicing it before parsing. Oversized source fields are reported through
  // searchProviderResponseTruncated instead.
  if (raw.length > 2_048) return
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
    if (parsed.username || parsed.password) return
    return parsed.toString()
  } catch {
    return
  }
}

/**
 * Decode the bounded `Title:` / `URL:` text layout that MCP search servers (Exa
 * today) return instead of structured rows. Only those two labelled fields are
 * trusted: the title is clipped, the URL goes through the same http(s)/credential
 * sanitizer as structured rows, and the remaining prose becomes a bounded
 * snippet. Blocks without both fields are dropped, so a provider cannot smuggle
 * an unbounded body into the model's context.
 */
export function parseProseSearchRows(value: string, limit: number): SearchResultItem[] {
  const boundedLimit = Math.min(10, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8))
  const results: SearchResultItem[] = []
  const lines = value.split("\n")
  let index = 0
  while (index < lines.length && results.length < boundedLimit) {
    const heading = lines[index]!.trim()
    index++
    if (!heading.startsWith("Title:")) continue
    const title = heading.slice(6).trim()
    const snippet: string[] = []
    let href: string | undefined
    while (index < lines.length) {
      const line = lines[index]!.trim()
      if (line.startsWith("Title:")) break
      index++
      if (line.startsWith("URL:")) {
        if (href === undefined) href = url(line.slice(4).trim())
        continue
      }
      if (!line || line === "---" || snippet.length >= 24) continue
      snippet.push(line)
    }
    if (!title || !href) continue
    const text = snippet.join(" ").slice(0, 1_200)
    results.push({ title: title.slice(0, 240), url: href, ...(text ? { snippet: text } : {}) })
  }
  return results
}

export function parseSearchProviderResponse(provider: SearchRouteID, payload: unknown, limit: number, depth = 0): SearchResultItem[] {
  // MCP structuredContent and text blocks are untrusted provider payloads. Keep
  // wrapper decoding shallow so a provider cannot turn a bounded response body
  // into unbounded recursive work.
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 4) return []
  const boundedLimit = Math.min(10, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8))
  const root = record(payload)
  const shape = providerShape(provider)
  if (!root) return []
  const result = record(root.result)
  if (result?.structuredContent) return parseSearchProviderResponse(provider, result.structuredContent as unknown, boundedLimit, depth + 1)
  // A standards-shaped MCP JSON-RPC reply carries its blocks under `result`,
  // while a bare MCP result body carries them at the top level. HostKernel hands
  // over the whole frame, so inspecting only `root.content` decoded every real
  // provider reply as zero results.
  const contentBlocks = Array.isArray(root.content)
    ? root.content
    : Array.isArray(result?.content) ? result.content : undefined
  if (contentBlocks) {
    for (const entry of contentBlocks.slice(0, MAX_MCP_CONTENT_BLOCKS)) {
      const rawText = record(entry)?.text
      if (typeof rawText !== "string" || rawText.length > MAX_MCP_TEXT_CHARS) continue
      try {
        const parsed: SearchResultItem[] = parseSearchProviderResponse(provider, JSON.parse(rawText) as unknown, boundedLimit, depth + 1)
        if (parsed.length) return parsed
      } catch {
        // Exa publishes its rows as a labelled text layout instead of JSON;
        // decode that bounded shape rather than reporting a successful search
        // as an undecodable payload.
        const prose = parseProseSearchRows(rawText, boundedLimit)
        if (prose.length) return prose
      }
    }
  }
  const rootData = record(root.data)
  const results = record(root.results)
  const data = shape === "brave" ? record(root.web)
    : shape === "youcom" ? record(results?.web)
      : record(rootData?.web) ?? root
  // The You.com search API returns `results.web` as an array, whereas other
  // fixed adapters use an object containing `results`.
  const directRows = shape === "youcom" && Array.isArray(results?.web)
    ? results.web
    : shape === "firecrawl" && Array.isArray(rootData?.web) ? rootData.web : undefined
  const rows = directRows ?? data?.results ?? root.results
  if (!Array.isArray(rows)) return []
  // Skip malformed/non-web rows without allowing them to consume the result
  // budget. The response frame is already byte-bounded by HostKernel; inspect
  // at most ten candidates per requested result to bound adapter work.
  return rows.slice(0, boundedLimit * 10).flatMap((row) => {
    const item = record(row)
    if (!item) return []
    const title = text(item.title, 240)
    const href = url(item.url)
    const extra = Array.isArray(item.extra_snippets) ? item.extra_snippets[0] : undefined
    const content = Array.isArray(item.contents) ? record(item.contents[0]) : undefined
    const snippets = Array.isArray(item.snippets) ? item.snippets : undefined
    const snippet = text(shape === "brave"
      ? (item.description ?? extra)
      : (content?.text ?? item.description ?? item.snippet ?? item.content ?? (Array.isArray(item.excerpts) ? item.excerpts[0] : undefined) ?? snippets?.[0] ?? item.text), 1_200)
    if (!title || !href) return []
    return [{ title, url: href, ...(snippet ? { snippet } : {}) }]
  }).slice(0, boundedLimit)
}

/** Whether the bounded parser omitted provider rows or clipped a returned field. */
export function searchProviderResponseTruncated(provider: SearchRouteID, payload: unknown, limit: number, depth = 0): boolean {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 4) return false
  const boundedLimit = Math.min(10, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8))
  const root = record(payload)
  const shape = providerShape(provider)
  if (!root) return false
  const result = record(root.result)
  if (result?.structuredContent) return searchProviderResponseTruncated(provider, result.structuredContent, boundedLimit, depth + 1)
  const truncBlocks = Array.isArray(root.content)
    ? root.content
    : Array.isArray(result?.content) ? result.content : undefined
  if (truncBlocks) {
    if (truncBlocks.length > MAX_MCP_CONTENT_BLOCKS) return true
    for (const entry of truncBlocks.slice(0, MAX_MCP_CONTENT_BLOCKS)) {
      const rawText = record(entry)?.text
      if (typeof rawText !== "string") continue
      if (rawText.length > MAX_MCP_TEXT_CHARS) return true
      try {
        const parsed: unknown = JSON.parse(rawText)
        if (parseSearchProviderResponse(provider, parsed, boundedLimit).length) {
          return searchProviderResponseTruncated(provider, parsed, boundedLimit, depth + 1)
        }
      } catch {
        // Non-JSON explanatory text is ignored by the result parser.
      }
    }
  }
  const rootData = record(root.data)
  const results = record(root.results)
  const data = shape === "brave" ? record(root.web)
    : shape === "youcom" ? record(results?.web)
      : record(rootData?.web) ?? root
  const rows = shape === "youcom" && Array.isArray(results?.web)
    ? results.web
    : shape === "firecrawl" && Array.isArray(rootData?.web) ? rootData.web : data?.results ?? root.results
  if (!Array.isArray(rows)) return false
  if (rows.length > boundedLimit) return true
  return rows.some((raw) => {
    const item = record(raw)
    if (!item) return false
    const content = Array.isArray(item.contents) ? record(item.contents[0]) : undefined
    const snippets = Array.isArray(item.snippets) ? item.snippets : undefined
    const extra = Array.isArray(item.extra_snippets) ? item.extra_snippets[0] : undefined
    const snippet = shape === "brave"
      ? (item.description ?? extra)
      : (content?.text ?? item.description ?? item.snippet ?? item.content ?? (Array.isArray(item.excerpts) ? item.excerpts[0] : undefined) ?? snippets?.[0] ?? item.text)
    return (typeof item.title === "string" && item.title.length > 240) ||
      (typeof item.url === "string" && item.url.length > 2_048) ||
      (typeof snippet === "string" && snippet.length > 1_200)
  })
}
