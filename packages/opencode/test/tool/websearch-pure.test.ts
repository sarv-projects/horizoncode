import { expect, test } from "bun:test"
import {
  createSearchInspectionRoutes,
  createSearchRoutePlan,
  parseSearchProviderResponse,
  searchProviderResponseTruncated,
} from "@/tool/websearch-adapters"

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
