import { describe, expect, test } from "bun:test"
import {
  DIRECT_PROVIDER_CREDENTIAL_PLACEHOLDER,
  prepareDirectProviderTransportRequest,
  type DirectProviderRouteV1,
} from "../../src/auth/provider-transport"
import { SecretBrokerError } from "../../src/auth/secret-broker"

// Synthetic credential fixture. Never a real provider key.
const KEY = `sk-or-v1-${"a".repeat(64)}`

const route = (overrides: Partial<DirectProviderRouteV1> = {}): DirectProviderRouteV1 => ({
  providerID: "openrouter",
  modelID: "nvidia/nemotron-3.5-super-vl:free",
  harnessID: "native-rich",
  routeID: `llm_${"a".repeat(64)}`,
  routeRevision: `llm_${"a".repeat(64)}`,
  endpointRevision: `blake3:${"b".repeat(64)}`,
  endpointBase: "https://openrouter.ai/api/v1",
  anonymousOpenCodeFree: false,
  explicitFreeCredential: true,
  credentialHeader: { name: "authorization", prefix: "Bearer " },
  ...overrides,
})

describe("P6 credentialed free-provider request preparation", () => {
  test("accepts only the SDK placeholder and removes it before the authorized transport", async () => {
    const prepared = await prepareDirectProviderTransportRequest({
      route: route(),
      input: "https://openrouter.ai/api/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${DIRECT_PROVIDER_CREDENTIAL_PLACEHOLDER}`,
        },
        body: JSON.stringify({ model: "nvidia/nemotron-3.5-super-vl:free", messages: [] }),
      },
    })

    expect(prepared.transport.providerId).toBe("openrouter")
    expect(prepared.transport.destination).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(prepared.transport.headers).not.toHaveProperty("authorization")
    expect(prepared.transportRequestDigest).toMatch(/^blake3:[a-f0-9]{64}$/)
    expect(JSON.stringify(prepared)).not.toContain(DIRECT_PROVIDER_CREDENTIAL_PLACEHOLDER)
    expect(JSON.stringify(prepared)).not.toContain(KEY)
  })

  test("rejects any caller-injected credential instead of forwarding it", async () => {
    const error = await prepareDirectProviderTransportRequest({
      route: route(),
      input: "https://openrouter.ai/api/v1/chat/completions",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: "nvidia/nemotron-3.5-super-vl:free", messages: [] }),
      },
    }).then(() => undefined, (cause: unknown) => cause)

    expect(error).toBeInstanceOf(SecretBrokerError)
    expect(String(error)).not.toContain(KEY)
  })

  test("refuses another model, destination, or provider before dispatch", async () => {
    const request = {
      input: "https://openrouter.ai/api/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${DIRECT_PROVIDER_CREDENTIAL_PLACEHOLDER}`,
        },
        body: JSON.stringify({ model: "nvidia/nemotron-3.5-super-vl:free", messages: [] }),
      },
    }
    await expect(prepareDirectProviderTransportRequest({
      route: route({ modelID: "openai/gpt-5-paid" }),
      ...request,
    })).rejects.toBeInstanceOf(SecretBrokerError)
    await expect(prepareDirectProviderTransportRequest({
      route: route({ providerID: "anthropic" }),
      ...request,
    })).rejects.toBeInstanceOf(SecretBrokerError)
    await expect(prepareDirectProviderTransportRequest({
      route: route(),
      ...request,
      input: "https://openrouter.ai.evil.invalid/api/v1/chat/completions",
    })).rejects.toBeInstanceOf(SecretBrokerError)
  })

  test("still prepares the unchanged anonymous OpenCode route", async () => {
    const prepared = await prepareDirectProviderTransportRequest({
      route: route({
        providerID: "opencode",
        modelID: "big-pickle",
        endpointBase: "https://opencode.ai/api",
        anonymousOpenCodeFree: true,
        explicitFreeCredential: undefined,
      }),
      input: "https://opencode.ai/api/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    })
    expect(prepared.transport.headers.authorization).toBe("Bearer public")
  })
})
