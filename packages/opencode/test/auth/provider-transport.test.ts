import { describe, expect, test } from "bun:test"
import {
  createPinnedDirectProviderFetch,
  prepareDirectProviderTransportRequest,
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
