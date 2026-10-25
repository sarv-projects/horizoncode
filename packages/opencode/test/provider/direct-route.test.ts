import { describe, expect, test } from "bun:test"
import {
  assertDirectProviderRouteMatchV1,
  digestDirectProviderRequestPinsV1,
  validateDirectProviderRequestPinsV1,
  type DirectProviderRequestPinsV1,
} from "@opencode-ai/core/session/provider-request"

const blake3 = (char: string) => `blake3:${char.repeat(64)}`
const sha256 = (char: string) => `sha256:${char.repeat(64)}`
const routeID = `llm_${"a".repeat(64)}`

function pins(overrides: Partial<DirectProviderRequestPinsV1> = {}): DirectProviderRequestPinsV1 {
  const value: DirectProviderRequestPinsV1 = {
    sessionID: "ses_directroute1" as DirectProviderRequestPinsV1["sessionID"],
    requestID: "req_direct_1",
    sourceRevision: "1",
    profileID: "builtin.horizon-coding",
    profileRevision: "1",
    profileDigest: blake3("b"),
    permissionScopeDigest: sha256("c"),
    contextSelection: {
      schemaVersion: 1,
      lane: "direct",
      sessionID: "ses_directroute1" as never,
      requestID: "req_direct_1",
      mode: "fresh",
      sourceRevision: "1",
      sources: [
        {
          kind: "provider-input",
          sourceID: "req_direct_1",
          sourceRevision: "1",
          contentDigest: blake3("d"),
          sourceAuthority: "core-prompt-compiler",
          trust: "mixed",
          included: true,
          inclusionReason: "current_request",
        },
        {
          kind: "agent-profile",
          sourceID: "builtin.horizon-coding",
          sourceRevision: "1",
          contentDigest: blake3("b"),
          sourceAuthority: "core-config",
          trust: "system",
          included: true,
          inclusionReason: "profile",
        },
      ],
    },
    providerID: "opencode",
    modelID: "big-pickle",
    harnessID: "native-rich",
    harnessRevision: "1",
    routeRevision: routeID,
    endpointRevision: blake3("e"),
    policyDigest: sha256("f"),
    normalizedInputDigest: blake3("d"),
    transportRequestDigest: blake3("1"),
  }
  return { ...value, ...overrides }
}

describe("direct provider route matching", () => {
  const route = {
    providerID: "opencode",
    modelID: "big-pickle",
    harnessID: "native-rich",
    routeID,
    routeRevision: routeID,
    endpointRevision: blake3("e"),
  }

  test("accepts only the exact pinned provider/model/harness/route/endpoint tuple", () => {
    expect(() => assertDirectProviderRouteMatchV1(pins(), route)).not.toThrow()
  })

  test("rejects each independent route field mismatch without fallback", () => {
    const cases: Array<[string, Partial<typeof route>]> = [
      ["provider", { providerID: "other" }],
      ["model", { modelID: "other" }],
      ["harness", { harnessID: "native-minimal" }],
      ["route revision", { routeID: `llm_${"2".repeat(64)}`, routeRevision: `llm_${"2".repeat(64)}` }],
      ["endpoint revision", { endpointRevision: blake3("9") }],
    ]
    for (const [field, change] of cases) {
      expect(() => assertDirectProviderRouteMatchV1(pins(), { ...route, ...change })).toThrow(field)
    }
  })

  test("rejects a route whose ID is not its revision or is malformed", () => {
    expect(() =>
      assertDirectProviderRouteMatchV1(pins(), { ...route, routeID: `llm_${"2".repeat(64)}` }),
    ).toThrow("route revision")
    expect(() =>
      assertDirectProviderRouteMatchV1(pins(), { ...route, routeID: "caller-supplied", routeRevision: "caller-supplied" }),
    ).toThrow("route mismatch")
  })
})

describe("direct provider request pins", () => {
  test("validates the exact direct ContextSelection and is canonical", () => {
    const validated = validateDirectProviderRequestPinsV1(pins())
    expect(validated.contextSelection.lane).toBe("direct")
    expect(digestDirectProviderRequestPinsV1(pins())).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(digestDirectProviderRequestPinsV1(pins())).toBe(digestDirectProviderRequestPinsV1(pins()))
  })

  test("rejects a rewritten provider input or profile pin", () => {
    expect(() =>
      validateDirectProviderRequestPinsV1(pins({ normalizedInputDigest: blake3("8") })),
    ).toThrow(/ContextSelection/)
    const { contextSelection: _selection, ...withoutSelection } = pins()
    expect(() => validateDirectProviderRequestPinsV1(withoutSelection as DirectProviderRequestPinsV1)).toThrow()
  })

  test("rejects a managed lane or session/request substitution", () => {
    const base = pins()
    expect(() =>
      validateDirectProviderRequestPinsV1({
        ...base,
        requestID: "req_direct_2",
      }),
    ).toThrow(/ContextSelection/)
    expect(() =>
      validateDirectProviderRequestPinsV1({
        ...base,
        contextSelection: { ...base.contextSelection, lane: "managed" as never },
      }),
    ).toThrow()
  })
})
