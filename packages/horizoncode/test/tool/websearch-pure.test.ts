import { expect, test } from "bun:test"
import {
  createSearchInspectionRoutes,
  createSearchRoutePlan,
  parseSearchProviderResponse,
  searchProviderResponseTruncated,
} from "@/tool/websearch-adapters"
import {
  hasEnabledSearchRouteReady,
  normalizeSearchCascadeSettings,
  WEB_SEARCH_ANONYMOUS_RUNTIME_READY,
  WEB_SEARCH_BYO_RUNTIME_READY,
} from "@/tool/websearch-broker"

test("search release gates stay closed after consent", () => {
  const settings = normalizeSearchCascadeSettings({
    querySharingConsent: "anonymous_free_v1",
    byoConsents: [{ route: "brave", consent: "secret_broker_unknown_cost_v1" }],
    enabled: ["exa_keyless", "brave"],
    order: ["exa_keyless", "brave"],
  })
  expect(settings.enabled).toEqual(["exa_keyless", "brave"])
  expect(WEB_SEARCH_ANONYMOUS_RUNTIME_READY).toBe(false)
  expect(WEB_SEARCH_BYO_RUNTIME_READY).toBe(false)
  expect(hasEnabledSearchRouteReady(settings)).toBe(false)
})

const secretRef = {
  schemaVersion: 1,
  secretRef: "secret_route_reference_1",
  provider: "brave",
  authKind: "api_key",
} as never

test("the trusted route plan never widens enablement or route class", () => {
  const plan = createSearchRoutePlan({
    enabled: ["exa_keyless", "brave"],
    order: ["brave", "exa_keyless"],
    supportedProviders: ["exa_keyless", "youcom_free", "brave", "exa"],
    // A BYO route without an opaque SecretBroker reference cannot execute.
    credentialRefs: {},
  })

  expect(plan.routes).toEqual(["exa_keyless"])
  expect(plan.provenance).toEqual([
    { provider: "exa_keyless", label: "Built-in default · Exa", costClass: "FREE", authSource: "none" },
  ])
})

test("an explicitly enabled and referenced BYO route joins only its approved order", () => {
  const plan = createSearchRoutePlan({
    enabled: ["exa_keyless", "brave", "youcom_free"],
    order: ["brave", "youcom_free", "exa_keyless"],
    supportedProviders: ["exa_keyless", "youcom_free", "brave"],
    credentialRefs: { brave: secretRef },
  })

  expect(plan.routes).toEqual(["brave", "youcom_free", "exa_keyless"])
  expect(plan.credentialRefsByRoute).toEqual([{ routeKey: "brave", secretRef }])
  expect(plan.provenance.map((route) => [route.provider, route.costClass, route.authSource])).toEqual([
    ["brave", "UNKNOWN", "secret_broker"],
    ["youcom_free", "FREE", "none"],
    ["exa_keyless", "FREE", "none"],
  ])
})

test("a disabled free route is never used as a hidden paid fallback", () => {
  const plan = createSearchRoutePlan({
    enabled: ["brave"],
    order: ["brave", "exa_keyless"],
    supportedProviders: ["exa_keyless", "brave"],
    credentialRefs: { brave: secretRef },
  })

  expect(plan.routes).toEqual(["brave"])
  expect(plan.routes).not.toContain("exa_keyless")
})

test("inspection reports disabled referenced BYO routes without contacting a provider", () => {
  const routes = createSearchInspectionRoutes({
    supportedProviders: ["exa_keyless", "brave", "tavily"],
    credentialRefs: { brave: secretRef },
  })

  expect(routes.find((route) => route.id === "brave")).toMatchObject({ configured: true, costClass: "UNKNOWN", authSource: "secret_broker" })
  expect(routes.find((route) => route.id === "tavily")).toBeUndefined()
  expect(routes.find((route) => route.id === "exa_keyless")).toMatchObject({ configured: true, costClass: "FREE", authSource: "none" })
})

test("provider parsing accepts only bounded http(s) result rows", () => {
  const parsed = parseSearchProviderResponse("brave", {
    web: {
      results: [
        { title: "Allowed", url: "https://example.com/docs", description: "snippet" },
        { title: "Unsafe", url: "javascript:alert(1)" },
        { title: "Credentialed", url: "https://user:pass@example.com/private" },
        { title: "Missing URL" },
      ],
    },
  }, 8)

  expect(parsed).toEqual([{ title: "Allowed", url: "https://example.com/docs", snippet: "snippet" }])
})

test("provider parsing rejects an overlong URL instead of linking its truncated prefix", () => {
  const parsed = parseSearchProviderResponse("exa_keyless", {
    results: [{ title: "Overlong", url: `https://example.com/${"a".repeat(2_048)}` }],
  }, 1)

  expect(parsed).toEqual([])
  expect(searchProviderResponseTruncated("exa_keyless", {
    results: [{ title: "Overlong", url: `https://example.com/${"a".repeat(2_048)}` }],
  }, 1)).toBe(true)
})

test("provider parsing bounds MCP text wrappers and reports truncation", () => {
  const payload = {
    content: [{
      type: "text",
      text: JSON.stringify({ results: [{ title: "One", url: "https://example.com/1" }, { title: "Two", url: "https://example.com/2" }] }),
    }],
  }

  expect(parseSearchProviderResponse("exa_keyless", payload, 1)).toEqual([
    { title: "One", url: "https://example.com/1" },
  ])
  expect(searchProviderResponseTruncated("exa_keyless", payload, 1)).toBe(true)
  expect(searchProviderResponseTruncated("exa_keyless", payload, 8)).toBe(false)
})

test("provider parsing decodes the standards-shaped MCP envelope with Exa prose rows", () => {
  // Real mcp.exa.ai shape observed live: the blocks sit under `result.content`
  // and each row is a labelled text layout, not JSON.
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{
        type: "text",
        text: [
          "Title: httpx v0.28.1",
          "URL: https://pypi.org/project/httpx/",
          "Published: N/A",
          "Highlights:",
          "# httpx v0.28.1",
          "---",
          "",
          "Title: Releases · encode/httpx · GitHub",
          "URL: https://github.com/encode/httpx/releases",
          "Highlights:",
          "## Version 0.28.1",
        ].join("\n"),
      }],
    },
  }

  const parsed = parseSearchProviderResponse("exa_keyless", payload, 8)
  expect(parsed.map((row) => row.url)).toEqual([
    "https://pypi.org/project/httpx/",
    "https://github.com/encode/httpx/releases",
  ])
  expect(parsed[0]!.title).toBe("httpx v0.28.1")
  expect(parsed[0]!.snippet).toContain("0.28.1")
})

test("provider parsing keeps prose rows bounded and drops unsafe URLs", () => {
  const payload = {
    result: {
      content: [{
        type: "text",
        text: [
          "Title: Unsafe",
          "URL: javascript:alert(1)",
          "Title: Too many",
          "URL: https://example.com/1",
          "Title: Second",
          "URL: https://example.com/2",
        ].join("\n"),
      }],
    },
  }

  expect(parseSearchProviderResponse("exa_keyless", payload, 8).map((row) => row.url)).toEqual([
    "https://example.com/1",
    "https://example.com/2",
  ])
  expect(parseSearchProviderResponse("exa_keyless", payload, 1)).toHaveLength(1)
})

test("provider parsing decodes the Firecrawl nested JSON text block", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          data: { web: [{ url: "https://pypi.org/project/httpx/", title: "httpx", description: "# httpx 0.28.1" }] },
        }),
      }],
    },
  }

  expect(parseSearchProviderResponse("firecrawl_keyless", payload, 4)).toEqual([
    { title: "httpx", url: "https://pypi.org/project/httpx/", snippet: "# httpx 0.28.1" },
  ])
})
