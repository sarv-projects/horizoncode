import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Env } from "../../src/env"
import { Provider } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node])))

it.instance(
  "Cloudflare credentialed provider dispatch is unavailable before SecretBroker transport",
  () => Effect.gen(function* () {
    const previous = process.env.OPENAI_BASE_URL
    process.env.OPENAI_BASE_URL = "https://unrelated.invalid/v1"
    try {
      yield* Env.use.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      yield* Env.use.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      yield* Env.use.set("CLOUDFLARE_API_TOKEN", "test-gateway-token")
      const provider = yield* Provider.Service
      const configured = yield* provider.getProvider(ProviderV2.ID.make("cloudflare-ai-gateway"))
      const requests: Array<{ url: string; body: unknown; headers: Headers }> = []
      configured.options.fetch = async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) })
        return Response.json({
          id: "resp_test", object: "response", created_at: 0, model: "gpt-5.4", status: "completed",
          error: null, incomplete_details: null,
          output: [{ type: "message", role: "assistant", id: "msg_test", status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        })
      }
      const model = yield* provider.getModel(ProviderV2.ID.make("cloudflare-ai-gateway"), ModelV2.ID.make("openai/gpt-5.4"))
      const unavailable = yield* provider.getLanguage(model).pipe(
        Effect.catchTag("ProviderCredentialTransportUnavailableError", (error) => Effect.succeed(error)),
      )
      expect(Provider.CredentialTransportUnavailableError.isInstance(unavailable)).toBe(true)
      expect(requests).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previous
    }
  }),
  { config: { provider: { "cloudflare-ai-gateway": { models: {
    "openai/gpt-5.4": { name: "GPT 5.4", provider: { npm: "@ai-sdk/openai" } },
  } } } } },
)
