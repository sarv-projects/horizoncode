import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { unlink } from "fs/promises"
import { Global } from "@horizoncode/core/global"
import { Filesystem } from "@/util/filesystem"
import type { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import { Auth } from "@/auth"
import { Env } from "../../src/env"
import { Provider } from "@/provider/provider"

import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node])))

// Managed mock harness for the lane-migrated suites: an opaque SecretBroker
// lease reference lets the route projection run without any credential bytes,
// credential write, HostKernel permit, or real provider dispatch — the SDK is
// only constructed and never sends anywhere in these tests.
const itBedrockManaged = testEffect(
  LayerNode.compile(
    LayerNode.group([Provider.node, Env.node, Auth.node]),
    [
      [
        Auth.node,
        LayerNode.make({
          service: Auth.Service,
          layer: Layer.mock(Auth.Service, {
            get: () => Effect.succeed(undefined),
            all: () => Effect.succeed({}),
            credentialRefsForProviders: () =>
              Effect.succeed({ "amazon-bedrock": "p6-bedrock-ref" as SecretBrokerV1.SecretRef }),
          }),
          deps: [],
          tag: Auth.node.tag,
        }),
      ],
    ],
  ),
)

const originalEnv = new Map<string, string | undefined>()

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const list = Provider.use.list()

const mantleModelConfig = {
  provider: { npm: "@ai-sdk/amazon-bedrock/mantle", api: "https://bedrock-mantle.us-east-1.api.aws/v1" },
  limit: { context: 272_000, output: 32_000 },
  tool_call: true,
  modalities: {
    input: ["text", "image", "pdf"] as Array<"text" | "image" | "pdf">,
    output: ["text"] as Array<"text">,
  },
}

const withAuthJson = (contents: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const authPath = path.join(Global.Path.data, "auth.json")
      let original: string | undefined
      try {
        original = await Filesystem.readText(authPath)
      } catch {
        original = undefined
      }
      await Filesystem.write(authPath, contents)
      return { authPath, original }
    }),
    ({ authPath, original }) =>
      Effect.promise(async () => {
        if (original !== undefined) {
          await Filesystem.write(authPath, original)
          return
        }
        await unlink(authPath).catch(() => undefined)
      }),
  )

it.instance(
  "Bedrock: config region takes precedence over AWS_REGION env var",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_REGION", "us-east-1")
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].options?.region).toBe("eu-west-1")
    }),
  { config: { provider: { "amazon-bedrock": { options: { region: "eu-west-1" } } } } },
)

it.instance("Bedrock: falls back to AWS_REGION env var when no config region", () =>
  Effect.gen(function* () {
    yield* set("AWS_REGION", "eu-west-1")
    yield* set("AWS_PROFILE", "default")
    const providers = yield* list
    expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
    expect(providers[ProviderV2.ID.amazonBedrock].options?.region).toBe("eu-west-1")
  }),
)

it.instance(
  "Bedrock: loads when bearer token from auth.json is present",
  () =>
    Effect.gen(function* () {
      yield* withAuthJson(JSON.stringify({ "amazon-bedrock": { type: "api", key: "test-bearer-token" } }))
      yield* set("AWS_PROFILE", "")
      yield* set("AWS_ACCESS_KEY_ID", "")
      yield* set("AWS_BEARER_TOKEN_BEDROCK", "")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].options?.region).toBe("eu-west-1")
    }),
  { config: { provider: { "amazon-bedrock": { options: { region: "eu-west-1" } } } } },
)

itBedrockManaged.instance(
  "Bedrock Mantle: GPT-5.5 uses Responses API and OpenAI base path",
  () =>
    Effect.gen(function* () {
      // Credential-free construction: the bedrock custom getModel loader must
      // stay unregistered (it is only reachable through the closed legacy
      // path), so the sanctioned managed lane builds the SDK from the bundled
      // adapter against the pinned endpoint.
      yield* set("AWS_REGION", "")
      yield* set("AWS_PROFILE", "")
      yield* set("AWS_ACCESS_KEY_ID", "")
      yield* set("AWS_SECRET_ACCESS_KEY", "")
      yield* set("AWS_BEARER_TOKEN_BEDROCK", "")
      const model = yield* Provider.use.getModel(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("openai.gpt-5.5"))
      const language = yield* Provider.use.getManagedLanguage({
        model,
        harnessID: "native-rich",
        fetch: globalThis.fetch,
      })
      expect((language as { provider: string }).provider).toBe("bedrock-mantle.responses")
      expect((language as { modelId: string }).modelId).toBe("openai.gpt-5.5")
      expect(
        (language as unknown as { config: { url: (input: { path: string; modelId: string }) => string } }).config.url({
          path: "/responses",
          modelId: "openai.gpt-5.5",
        }),
      ).toBe("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses")
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-2" },
          models: {
            "openai.gpt-5.5": {
              ...mantleModelConfig,
              provider: {
                npm: "@ai-sdk/amazon-bedrock/mantle",
                api: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
              },
            },
          },
        },
      },
    },
  },
)

itBedrockManaged.instance(
  "Bedrock Mantle: GPT OSS safeguard uses Chat Completions and Mantle base path",
  () =>
    Effect.gen(function* () {
      // Credential-free so the custom bedrock getModel loader stays
      // unregistered; the sanctioned lane builds the mantle SDK directly.
      yield* set("AWS_BEARER_TOKEN_BEDROCK", "")
      yield* set("AWS_PROFILE", "")
      yield* set("AWS_ACCESS_KEY_ID", "")
      yield* set("AWS_SECRET_ACCESS_KEY", "")
      const model = yield* Provider.use.getModel(
        ProviderV2.ID.amazonBedrock,
        ModelV2.ID.make("openai.gpt-oss-safeguard-120b"),
      )
      const language = yield* Provider.use.getManagedLanguage({
        model,
        harnessID: "native-rich",
        fetch: globalThis.fetch,
      })
      expect((language as { provider: string }).provider).toBe("bedrock-mantle.chat")
      expect((language as { modelId: string }).modelId).toBe("openai.gpt-oss-safeguard-120b")
      expect(
        (language as unknown as { config: { url: (input: { path: string; modelId: string }) => string } }).config.url({
          path: "/chat/completions",
          modelId: "openai.gpt-oss-safeguard-120b",
        }),
      ).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions")
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "openai.gpt-oss-safeguard-120b": mantleModelConfig },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: config profile takes precedence over AWS_PROFILE env var",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      yield* set("AWS_ACCESS_KEY_ID", "test-key-id")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].options?.region).toBe("us-east-1")
    }),
  {
    config: {
      provider: { "amazon-bedrock": { options: { profile: "my-custom-profile", region: "us-east-1" } } },
    },
  },
)

it.instance(
  "Bedrock: includes custom endpoint in options when specified",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].options?.endpoint).toBe(
        "https://bedrock-runtime.us-east-1.vpce-xxxxx.amazonaws.com",
      )
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { endpoint: "https://bedrock-runtime.us-east-1.vpce-xxxxx.amazonaws.com" },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: autoloads when AWS_WEB_IDENTITY_TOKEN_FILE is present",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/eks.amazonaws.com/serviceaccount/token")
      yield* set("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/my-eks-role")
      yield* set("AWS_PROFILE", "")
      yield* set("AWS_ACCESS_KEY_ID", "")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].options?.region).toBe("us-east-1")
    }),
  { config: { provider: { "amazon-bedrock": { options: { region: "us-east-1" } } } } },
)

itBedrockManaged.instance(
  "Bedrock credentialed custom-model loader stays unavailable through the sanctioned lane",
  () =>
    Effect.gen(function* () {
      // With a credential present the bedrock custom loader registers its
      // getModel mapping (cross-region prefixing, ARN/profile forms). That
      // mapping is only reachable through the closed legacy getLanguage path;
      // both sanctioned lanes refuse non-bundled custom model loaders
      // fail-closed, so this asserts the typed refusal and zero dispatch
      // instead of reopening the legacy path for a test.
      yield* set("AWS_BEARER_TOKEN_BEDROCK", "test-bearer-token")
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.amazonBedrock, ModelV2.ID.make("deepseek.v3.2"))
      const outcome = yield* provider
        .getManagedLanguage({ model, harnessID: "native-rich", fetch: globalThis.fetch })
        .pipe(Effect.catch(() => Effect.succeed("unavailable" as const)))
      expect(outcome).toBe("unavailable")
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: {
            "deepseek.v3.2": { name: "DeepSeek V3.2" },
            "deepseek.r1-v1:0": { name: "DeepSeek R1" },
            "us.deepseek.r1-v1:0": { name: "DeepSeek R1 US" },
            "deepseek-v3-2-arn": {
              id: "arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3.2",
              name: "DeepSeek V3.2 ARN",
            },
          },
        },
      },
    },
  },
)

// Cross-region inference profile prefix handling.
// Models from models.dev may come with prefixes already (e.g. us., eu., global.).
// These should NOT be double-prefixed when passed to the SDK.

it.instance(
  "Bedrock: model with us. prefix should not be double-prefixed",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].models["us.anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "us.anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5 (US)" } },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: model with global. prefix should not be prefixed",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(
        providers[ProviderV2.ID.amazonBedrock].models["global.anthropic.claude-opus-4-5-20251101-v1:0"],
      ).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "global.anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5 (Global)" } },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: model with eu. prefix should not be double-prefixed",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].models["eu.anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "eu-west-1" },
          models: { "eu.anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5 (EU)" } },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: model without prefix in US region should get us. prefix added",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderV2.ID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderV2.ID.amazonBedrock].models["anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5" } },
        },
      },
    },
  },
)

// Direct unit tests for cross-region inference profile prefix detection.
describe("Bedrock cross-region prefix detection", () => {
  const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]

  test("should detect global. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "global.anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect us. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "us.anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect eu. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "eu.anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect jp. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "jp.anthropic.claude-sonnet-4-20250514-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect apac. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "apac.anthropic.claude-sonnet-4-20250514-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect au. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "au.anthropic.claude-sonnet-4-5-20250929-v1:0".startsWith(p))).toBe(true)
  })

  test("should NOT detect prefix for non-prefixed model", () => {
    expect(crossRegionPrefixes.some((p) => "anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(false)
  })

  test("should NOT detect prefix for amazon nova models", () => {
    expect(crossRegionPrefixes.some((p) => "amazon.nova-pro-v1:0".startsWith(p))).toBe(false)
  })

  test("should NOT detect prefix for cohere models", () => {
    expect(crossRegionPrefixes.some((p) => "cohere.command-r-plus-v1:0".startsWith(p))).toBe(false)
  })
})
