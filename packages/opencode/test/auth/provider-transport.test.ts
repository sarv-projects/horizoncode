import { describe, expect, test } from "bun:test"
import {
  createPinnedDirectProviderFetch,
  prepareDirectProviderTransportRequest,
  prepareManagedProviderTransportRequest,
  retainManagedProviderSendAuthorization,
  MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER,
  type DirectProviderRouteV1,
} from "../../src/auth/provider-transport"
import { SecretBrokerError } from "../../src/auth/secret-broker"

const route = (): DirectProviderRouteV1 => ({
  providerID: "opencode",
  modelID: "big-pickle",
  harnessID: "native-rich",
  routeID: `llm_${"a".repeat(64)}`,
  routeRevision: "route-1",
  endpointRevision: `blake3:${"b".repeat(64)}`,
  endpointBase: "https://opencode.example/v1",
  anonymousOpenCodeFree: true,
  credentialHeader: { name: "authorization", prefix: "Bearer " },
})

/**
 * Compile-time regressions for the direct route projection.
 *
 * P6 rationale: `DirectProviderRouteV1` intentionally carries the optional
 * `explicitFreeCredential?: true` marker (P6 explicit free-credential lane,
 * `Provider.getDirectFreeLanguage` in src/provider/provider.ts): one
 * user-authored, allow-listed, explicitly zero-priced model may be reached with
 * the operator's own key, and the frozen route records that class so the
 * free-credential gate can honor it. The marker is a route-class flag, never
 * credential material, and it grants nothing on its own: the setter keeps
 * `anonymousOpenCodeFree` `false`, so the journaled/pinned direct transport and
 * the managed route projection keep refusing the route until a Guarded
 * SecretBroker lease exists (runtime regression below). The original "a direct
 * route must not encode raw-key eligibility" negative therefore moves to
 * credential MATERIAL keys, while the marker itself stays constrained to the
 * positive optional literal `true`.
 */
type AssertTrue<T extends true> = T
type AssertFalse<T extends false> = T

/** Marker property type, hoisted: indexed access is illegal inside a deferred conditional. */
type FreeCredentialMarker = DirectProviderRouteV1["explicitFreeCredential"]

/** The P6 marker exists, but only as optional literal `true` - never `boolean` or `false`. */
export type DirectProviderRouteCarriesConstrainedFreeCredentialMarker = AssertTrue<
  "explicitFreeCredential" extends keyof DirectProviderRouteV1
    ? FreeCredentialMarker extends true | undefined
      ? true
      : false
    : false
>

/** A direct route still never encodes raw credential bytes - only the header profile. */
type CredentialMaterialKey = "apiKey" | "key" | "token" | "credential" | "credentials" | "authorization" | "rawCredential"
export type DirectProviderRouteExcludesCredentialMaterial = AssertFalse<
  [Extract<CredentialMaterialKey, keyof DirectProviderRouteV1>] extends [never] ? false : true
>

describe("anonymous direct provider credential header", () => {
  test("uses the canonical public placeholder only on the selected OpenCode route", async () => {
    const prepared = await prepareDirectProviderTransportRequest({
      route: route(),
      input: "https://opencode.example/v1/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    })

    expect(prepared.transport.headers.authorization).toBe("Bearer public")
    expect(prepared.transport.credentialHeader).toEqual({ name: "authorization", prefix: "Bearer " })
  })

  test("keeps an explicit-free-credential route out of the anonymous direct lane", async () => {
    // P6 free-credential gate: `explicitFreeCredential: true` marks a route
    // that carries the operator's own provider key (provider.ts
    // `getDirectFreeLanguage`). The marker grants no anonymous eligibility:
    // with `anonymousOpenCodeFree` false the pinned direct transport refuses
    // the route before any header/endpoint handling, so a raw-key route can
    // never reach dispatch until a Guarded SecretBroker lease exists.
    const explicitFree: DirectProviderRouteV1 = {
      ...route(),
      providerID: "openrouter",
      anonymousOpenCodeFree: false,
      explicitFreeCredential: true,
    }

    await expect(
      prepareDirectProviderTransportRequest({
        route: explicitFree,
        input: "https://opencode.example/v1/chat/completions",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" })
  })

  test("rejects malformed header names or prefixes before preparing a send", async () => {
    const invalidHeaders: unknown[] = [
      { name: "x-api-key", prefix: "" },
      { name: "authorization", prefix: "Basic " },
      { name: "authorization", prefix: "Bearer public\r\nX-Injected: yes" },
      null,
    ]

    for (const credentialHeader of invalidHeaders) {
      await expect(
        prepareDirectProviderTransportRequest({
          route: { ...route(), credentialHeader } as unknown as DirectProviderRouteV1,
          input: "https://opencode.example/v1/chat/completions",
          init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        }),
      ).rejects.toBeInstanceOf(SecretBrokerError)
    }
  })

  test("does not begin dispatch when the request is already cancelled", async () => {
    const prepared = await prepareDirectProviderTransportRequest({
      route: route(),
      input: "https://opencode.example/v1/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    })
    const controller = new AbortController()
    const reason = new Error("cancelled before dispatch")
    controller.abort(reason)
    let begins = 0
    let sends = 0
    let unknowns = 0
    const fetch = createPinnedDirectProviderFetch({
      prepared,
      expectedPinDigest: `blake3:${"c".repeat(64)}`,
      expectedTransportDigest: prepared.transportRequestDigest,
      journalState: "PINNED",
      beginDispatch: async () => {
        begins++
        return {
          state: "DISPATCHING",
          pinDigest: `blake3:${"c".repeat(64)}`,
          transportRequestDigest: prepared.transportRequestDigest,
        }
      },
      markUnknown: async () => {
        unknowns++
      },
      send: async () => {
        sends++
        return new Response(null, { status: 200 })
      },
      signal: controller.signal,
    })

    await expect(fetch("https://opencode.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).rejects.toBe(reason)
    expect(begins).toBe(0)
    expect(sends).toBe(0)
    expect(unknowns).toBe(0)
  })

  test("does not send when cancellation wins during the durable dispatch transition", async () => {
    const prepared = await prepareDirectProviderTransportRequest({
      route: route(),
      input: "https://opencode.example/v1/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    })
    const controller = new AbortController()
    const reason = new Error("cancelled while dispatch authorization was pending")
    const pinDigest = `blake3:${"c".repeat(64)}`
    let releaseBegin!: (value: {
      state: "DISPATCHING"
      pinDigest: string
      transportRequestDigest: string
    }) => void
    let markBeginCalled!: () => void
    const beginCalled = new Promise<void>((resolve) => {
      markBeginCalled = resolve
    })
    const beginResult = new Promise<{
      state: "DISPATCHING"
      pinDigest: string
      transportRequestDigest: string
    }>((resolve) => {
      releaseBegin = resolve
    })
    let sends = 0
    let unknowns = 0
    const fetch = createPinnedDirectProviderFetch({
      prepared,
      expectedPinDigest: pinDigest,
      expectedTransportDigest: prepared.transportRequestDigest,
      journalState: "PINNED",
      beginDispatch: () => {
        markBeginCalled()
        return beginResult
      },
      markUnknown: async () => {
        unknowns++
      },
      send: async () => {
        sends++
        return new Response(null, { status: 200 })
      },
      signal: controller.signal,
    })

    const dispatch = fetch("https://opencode.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    await beginCalled
    controller.abort(reason)
    releaseBegin({
      state: "DISPATCHING",
      pinDigest,
      transportRequestDigest: prepared.transportRequestDigest,
    })

    await expect(dispatch).rejects.toBe(reason)
    expect(sends).toBe(0)
    expect(unknowns).toBe(1)
  })

  test("preserves a provider error response while fencing the pinned dispatch as UNKNOWN without replay", async () => {
    const prepared = await prepareDirectProviderTransportRequest({
      route: route(),
      input: "https://opencode.example/v1/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    })
    const pinDigest = `blake3:${"c".repeat(64)}`
    let sends = 0
    const unknownReasons: string[] = []
    const fetch = createPinnedDirectProviderFetch({
      prepared,
      expectedPinDigest: pinDigest,
      expectedTransportDigest: prepared.transportRequestDigest,
      journalState: "PINNED",
      beginDispatch: async () => ({
        state: "DISPATCHING",
        pinDigest,
        transportRequestDigest: prepared.transportRequestDigest,
      }),
      markUnknown: async (reason) => {
        unknownReasons.push(reason)
      },
      send: async (request) => {
        sends++
        expect(request.url).toBe("https://opencode.example/v1/chat/completions")
        return new Response("provider-error", {
          status: 429,
          statusText: "Rate Limited",
          headers: { "content-type": "text/plain", "retry-after": "7" },
        })
      },
    })
    const first = await fetch("https://opencode.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(first.status).toBe(429)
    expect(first.statusText).toBe("Rate Limited")
    expect(first.headers.get("retry-after")).toBe("7")
    await expect(first.text()).resolves.toBe("provider-error")
    expect(unknownReasons).toEqual(["provider returned HTTP 429 without a canonical response settlement"])
    await expect(fetch("https://opencode.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).rejects.toMatchObject({ code: "CONFLICT" })
    expect(sends).toBe(1)
  })
})

describe("managed provider request bounds", () => {
  test("rejects a non-numeric SecretBroker expiry in the HostKernel authorization", () => {
    const pin = `blake3:${"a".repeat(64)}`
    const expected = {
      providerRequestID: "provider-request-1",
      prepareDigest: pin,
      dispatchDigest: pin,
      attemptID: "attempt-1",
      ownerEpoch: "1",
      requestID: "request-1",
      requestSequence: "1",
      contextSelectionDigest: pin,
      providerID: "test-provider",
      modelID: "test-model",
      harnessID: "native-rich",
      routeID: `llm_${"b".repeat(64)}`,
      credentialLeaseRef: "secret-ref-1",
      guardChallengeID: "challenge-1",
      effectID: "effect-1",
      capabilityLeaseDigest: pin,
      authorizationBindingDigest: pin,
      endpointRevision: pin,
      requestDigest: pin,
      transportRequestDigest: pin,
      operationDigest: `sha256:${"c".repeat(64)}`,
    } as const
    const permit = {
      ...expected,
      sendAuthorization: "one-use-token",
      secretUseContext: {
        requesterRef: "principal_" + "d".repeat(64),
        runRef: "run-1",
        profileRef: "profile-1",
        purpose: "PROVIDER_REQUEST",
        expiresAtUnixMs: String(Date.now() + 10_000),
      },
    }

    expect(() => retainManagedProviderSendAuthorization(permit, expected)).toThrow(/SecretBroker context is invalid/)
  })

  test("rejects an overlong destination before pinning the request", async () => {
    const endpointBase = "https://provider.example/v1"
    await expect(prepareManagedProviderTransportRequest({
      route: {
        providerID: "test-provider",
        modelID: "test-model",
        harnessID: "native-rich",
        routeID: `llm_${"a".repeat(64)}`,
        endpointRevision: `blake3:${"b".repeat(64)}`,
        credentialLeaseRef: "secret_test",
      },
      endpointBase,
      activeEndpointRevision: `blake3:${"b".repeat(64)}`,
      credentialHeader: { name: "authorization", prefix: "Bearer " },
      credentialPlaceholder: MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER,
      input: `${endpointBase}/${"a".repeat(8 * 1024)}`,
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    })).rejects.toBeInstanceOf(SecretBrokerError)
  })

  test("rejects excessive request headers before pinning the request", async () => {
    const endpointBase = "https://provider.example/v1"
    const headers = new Headers({
      authorization: `Bearer ${MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER}`,
      "content-type": "application/json",
    })
    for (let index = 0; index < 64; index++) headers.set(`x-test-${index}`, "x")

    await expect(prepareManagedProviderTransportRequest({
      route: {
        providerID: "test-provider",
        modelID: "test-model",
        harnessID: "native-rich",
        routeID: `llm_${"a".repeat(64)}`,
        endpointRevision: `blake3:${"b".repeat(64)}`,
        credentialLeaseRef: "secret_test",
      },
      endpointBase,
      activeEndpointRevision: `blake3:${"b".repeat(64)}`,
      credentialHeader: { name: "authorization", prefix: "Bearer " },
      credentialPlaceholder: MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER,
      input: `${endpointBase}/chat/completions`,
      init: { method: "POST", headers, body: "{}" },
    })).rejects.toBeInstanceOf(SecretBrokerError)
  })

  test("rejects an overlong header name before pinning the request", async () => {
    const endpointBase = "https://provider.example/v1"
    const headers = new Headers({
      authorization: `Bearer ${MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER}`,
      "content-type": "application/json",
    })
    headers.set(`x-${"a".repeat(128)}`, "value")

    await expect(prepareManagedProviderTransportRequest({
      route: {
        providerID: "test-provider",
        modelID: "test-model",
        harnessID: "native-rich",
        routeID: `llm_${"a".repeat(64)}`,
        endpointRevision: `blake3:${"b".repeat(64)}`,
        credentialLeaseRef: "secret_test",
      },
      endpointBase,
      activeEndpointRevision: `blake3:${"b".repeat(64)}`,
      credentialHeader: { name: "authorization", prefix: "Bearer " },
      credentialPlaceholder: MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER,
      input: `${endpointBase}/chat/completions`,
      init: { method: "POST", headers, body: "{}" },
    })).rejects.toBeInstanceOf(SecretBrokerError)
  })
})
