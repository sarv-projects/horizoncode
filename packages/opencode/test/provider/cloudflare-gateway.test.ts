import { expect } from "bun:test"
import { generateText } from "ai"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Env } from "../../src/env"
import { Provider } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node])))

it.instance(
  "Cloudflare native OpenAI selection ignores an unrelated host OpenAI endpoint",
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
      const language = yield* provider.getLanguage(model)
      const result = yield* Effect.promise(() => generateText({ model: language, prompt: "hi" }))
      expect(result.text).toBe("ok")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway")
      expect(requests[0]!.body).toMatchObject([{ provider: "openai", endpoint: "v1/responses", query: { model: "gpt-5.4" } }])
      expect(requests[0]!.headers.get("cf-aig-authorization")).toBe("Bearer test-gateway-token")
      expect(JSON.stringify(requests[0]!.body)).not.toContain("test-gateway-token")
      expect(JSON.stringify(requests[0]!.body)).not.toContain("unrelated.invalid")
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previous
    }
  }),
  { config: { provider: { "cloudflare-ai-gateway": { models: {
    "openai/gpt-5.4": { name: "GPT 5.4", provider: { npm: "@ai-sdk/openai" } },
  } } } } },
)
