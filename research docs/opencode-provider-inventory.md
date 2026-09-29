# OpenCode provider, model-directory, and authentication inventory

Reviewed 2026-09-28, with live catalog reads at 16:30 UTC. This is a **research snapshot**, not a claim that HorizonCode
implements these providers. The provider-ID and Go-model response snapshots below
were retrieved at that time; they are live service data, not data pinned by a source
commit. The original integration-file review is pinned at
`083ed266e058dc3d2d1b377ff5540859d79de110`; a supplementary provider/catalog/API
review was checked at current OpenCode `dev` commit
`7f964bbb00e505178847e2c08721b0fff56208f9` on 2026-09-28. A later focused provider
recheck at `083ed266…` read selected feed, auth, provider-loader, and prompt-cache
paths; it does not supersede every claim from the separately pinned `7f964bbb…`
review, nor constitute a full read of every provider module. Both scopes and exact
files are listed in their follow-up tables below. Official docs and live catalogs
are volatile. Recheck both exact upstream files and live APIs before implementation
or any statement about current availability.

## Do not collapse these source sets

OpenCode currently describes at least four different things:

1. **The dynamic model data feed.** OpenCode's pinned `packages/core/src/models-dev.ts`
   defaults to `https://models.opencode.ai/api.json`, validates a schema, uses a
   five-minute freshness window, a cross-process file lock, a temporary file plus
   rename, and a 60-minute background refresh. The code permits OpenCode-specific
   feed/path overrides. HorizonCode's proposed adapter uses only the fixed reviewed
   origin and an allowlisted inert projection; it does not execute the feed's `npm`
   package names or trust its `env`, endpoint, header, or auth data.
2. **The public provider documentation directory.** The page currently describes 51
   named provider sections plus `Custom provider`, and explicitly says it shows “some”
   providers in detail. It is not the complete provider catalog. Its overview says
   OpenCode uses the AI SDK and Models.dev to support 75+ LLM providers and local
   models; that is a broad ecosystem claim, not a count of verified HorizonCode routes.
3. **OpenCode executable provider integrations.** There are 32 files under
   `packages/core/src/plugin/provider/`, with adapters and dynamic integrations. This
   count does not map one-to-one to the documentation directory; many providers use
   shared/dynamic SDK integrations.
4. **OpenCode Go.** This is a separately documented subscription and model directory,
   served via OpenCode's Go service. It has distinct model availability, quotas,
   headers, and compatibility guidance. It is not the same as OpenCode Zen, the
   Models.dev feed, or the 51-entry partial documentation directory.

The docs and code are not perfectly synchronized: GitLab OAuth is documented while
the pinned provider implementation's auth wiring needs file-level review; the
Anthropic section describes a Claude Pro/Max sign-in and then explicitly says
Anthropic prohibits using those subscriptions through third-party plugins. The
coverage record must preserve such contradictions as `sources_conflict`, not resolve
them by assuming the convenient statement wins.

## Dynamic provider IDs in the OpenCode model feed

I fetched the actual public feed without credentials at
`https://models.opencode.ai/api.json` on 2026-09-28 16:30:47 UTC. The response was
5,214,814 bytes with SHA-256
`a03260a354cb2a97672eb582a94050a945762ad01890a368e69c4769755d69df`. It contained
225 provider IDs and 8,253 model records; every provider had at least one model in
this response. The full JSON was not copied into this repository. The following is
the complete sorted provider-ID list from that response. This snapshot is volatile;
the data digest and count apply only to this retrieval.

| Provider ID | Feed display name | Authentication evidence in this snapshot |
|---|---|---|
| `302ai` | 302.AI | Documented setup/auth matrix row 1; HorizonCode still requires its own review |
| `abacus` | Abacus | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `abliteration-ai` | abliteration.ai | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `above` | above.dev | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `agentrouter` | AgentRouter | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `agnes` | Agnes AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ai-router` | AI-ROUTER | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ai21` | AI21 Labs | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `aiand` | ai& | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `aihubmix` | AIHubMix | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ainetcafe` | ainetcafe | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `aixy` | Aixy | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `aki-io` | AKI.IO | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `alibaba` | Alibaba | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `alibaba-cn` | Alibaba (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `alibaba-coding-plan` | Alibaba Coding Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `alibaba-coding-plan-cn` | Alibaba Coding Plan (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `alibaba-token-plan` | Alibaba Token Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `alibaba-token-plan-cn` | Alibaba Token Plan (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `amazon-bedrock` | Amazon Bedrock | Documented setup/auth matrix row 2; HorizonCode still requires its own review |
| `ambient` | Ambient | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `amd` | AMD | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `anthropic` | Anthropic | Documented setup/auth matrix row 3; HorizonCode still requires its own review |
| `anyapi` | AnyAPI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `arcee` | Arcee | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `atomic-chat` | Atomic Chat | Documented setup/auth matrix row 4; HorizonCode still requires its own review |
| `auriko` | Auriko | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `azure` | Azure | Documented setup/auth matrix row 5; HorizonCode still requires its own review |
| `azure-cognitive-services` | Azure Cognitive Services | Documented setup/auth matrix row 6; HorizonCode still requires its own review |
| `bailing` | Bailing | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `baseten` | Baseten | Documented setup/auth matrix row 7; HorizonCode still requires its own review |
| `bee` | Bee by HEOSSI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `berget` | Berget.AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `blueclaw` | Blue Claw | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `bothub` | Bothub | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `cerebras` | Cerebras | Documented setup/auth matrix row 8; HorizonCode still requires its own review |
| `chutes` | Chutes | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `clarifai` | Clarifai | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `claudinio` | Claudinio | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `cline-pass` | ClinePass | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `cloudferro-sherlock` | CloudFerro Sherlock | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `cloudflare-ai-gateway` | Cloudflare AI Gateway | Documented setup/auth matrix row 9; HorizonCode still requires its own review |
| `cloudflare-workers-ai` | Cloudflare Workers AI | Documented setup/auth matrix row 10; HorizonCode still requires its own review |
| `cohere` | Cohere | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `coralbricks` | CoralBricks | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `cortecs` | Cortecs | Documented setup/auth matrix row 11; HorizonCode still requires its own review |
| `crof` | CrofAI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `crossmodel` | CrossModel | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `crusoe` | Crusoe | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `daoxe` | DaoXE | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `databricks` | Databricks | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `deepinfra` | Deep Infra | Documented setup/auth matrix row 13; HorizonCode still requires its own review |
| `deepseek` | DeepSeek | Documented setup/auth matrix row 12; HorizonCode still requires its own review |
| `digitalocean` | DigitalOcean | Documented setup/auth matrix row 14; HorizonCode still requires its own review |
| `dinference` | DInference | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `drun` | D.Run (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ebcloud` | EBCloud | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `echo` | Echo | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `edenai` | Eden AI | Documented setup/auth matrix row 15; HorizonCode still requires its own review |
| `empiriolabs` | EmpirioLabs AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `evroc` | evroc | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `fastrouter` | FastRouter | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `fireworks-ai` | Fireworks AI | Documented setup/auth matrix row 17; HorizonCode still requires its own review |
| `freemodel` | FreeModel | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `friendli` | Friendli | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `frogbot` | FrogBot | Documented setup/auth matrix row 16; HorizonCode still requires its own review |
| `github-copilot` | GitHub Copilot | Documented setup/auth matrix row 19; HorizonCode still requires its own review |
| `gitlab` | GitLab Duo | Documented setup/auth matrix row 18; HorizonCode still requires its own review |
| `gmicloud` | GMI Cloud | Documented setup/auth matrix row 20; HorizonCode still requires its own review |
| `google` | Google | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `google-vertex` | Vertex | Documented setup/auth matrix row 21; HorizonCode still requires its own review |
| `google-vertex-anthropic` | Vertex (Anthropic) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `greenpt` | GreenPT | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `groq` | Groq | Documented setup/auth matrix row 22; HorizonCode still requires its own review |
| `helicone` | Helicone | Documented setup/auth matrix row 24; HorizonCode still requires its own review |
| `hetzner` | Hetzner | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `hpc-ai` | HPC-AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `huggingface` | Hugging Face | Documented setup/auth matrix row 23; HorizonCode still requires its own review |
| `hyper` | Charm Hyper | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `iflowcn` | iFlow | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `impossibl` | Impossibl | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `inception` | Inception | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `inceptron` | Inceptron | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `inco` | Inco | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `infer` | Infer by Flow7 | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `inference` | Inference | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `inferx` | InferX | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `infomaniak` | Infomaniak | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `io-net` | IO.NET | Documented setup/auth matrix row 26; HorizonCode still requires its own review |
| `iteracompute` | IteraCompute | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `jalapeno` | Jalapeno Cloud | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `jiekou` | Jiekou.AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `kenari` | Kenari | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `kilo` | Kilo Gateway | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `kimi-code-plan-cn` | Kimi For Coding (kimi.com) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `kimi-code-plan-global` | Kimi For Coding (kimi.ai) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `klokintegration` | klokintegration.se | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `kosmik` | Kosmik Compute | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `kuae-cloud-coding-plan` | KUAE Cloud Coding Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `lilac` | Lilac | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `llama` | Llama | Documented setup/auth matrix row 25; HorizonCode still requires its own review |
| `llmgateway` | DevPass (LLM Gateway) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `llmgateway-providers` | LLM Gateway | Documented setup/auth matrix row 38; HorizonCode still requires its own review |
| `llmtech` | LLM Tech | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `llmtr` | LLMTR | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `lmstudio` | LMStudio | Documented setup/auth matrix row 27; HorizonCode still requires its own review |
| `longcat` | LongCat | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `lucidquery` | LucidQuery | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `lynkr` | Lynkr | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `meganova` | Meganova | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `melious` | Melious | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `merge-gateway` | Merge Gateway | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `meta` | Meta | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `minimax` | MiniMax (minimax.io) | Documented setup/auth matrix row 29; HorizonCode still requires its own review |
| `minimax-cn` | MiniMax (minimax.cn) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `minimax-cn-coding-plan` | MiniMax Token Plan (minimax.cn) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `minimax-coding-plan` | MiniMax Token Plan (minimax.io) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `mistral` | Mistral | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `mixlayer` | Mixlayer | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `moark` | Moark | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `modal` | Modal | Documented setup/auth matrix row 30; HorizonCode still requires its own review |
| `model-oracle-ai` | Model Oracle AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `modelis` | Modelis | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `modelscope` | ModelScope | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `moonshotai` | Moonshot AI | Documented setup/auth matrix row 28; HorizonCode still requires its own review |
| `moonshotai-cn` | Moonshot AI (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `morph` | Morph | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `nan` | NaN | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `nano-gpt` | NanoGPT | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `nearai` | NEAR AI Cloud | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `nebius` | Nebius Token Factory | Documented setup/auth matrix row 32; HorizonCode still requires its own review |
| `neon` | Neon | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `neosmith` | NeoSmith | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `neuralwatt` | Neuralwatt | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `nova` | Nova | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `novita-ai` | NovitaAI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `nvidia` | Nvidia | Documented setup/auth matrix row 31; HorizonCode still requires its own review |
| `oci` | OCI Generative AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ofox` | Ofox | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ollama-cloud` | Ollama Cloud | Documented setup/auth matrix row 34; HorizonCode still requires its own review |
| `openai` | OpenAI | Documented setup/auth matrix row 35; HorizonCode still requires its own review |
| `opencode` | OpenCode Zen | Documented setup/auth matrix row 36; HorizonCode still requires its own review |
| `opencode-go` | OpenCode Go | Separate OpenCode Go documentation below; subscription/API-key inference method |
| `openreason` | OpenReason | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `openrouter` | OpenRouter | Documented setup/auth matrix row 37; HorizonCode still requires its own review |
| `opper` | Opper | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `orcarouter` | OrcaRouter | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `ovhcloud` | OVHcloud AI Endpoints | Documented setup/auth matrix row 42; HorizonCode still requires its own review |
| `pareto` | Pareto Inference | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `pendra` | Pendra | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `perplexity` | Perplexity | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `perplexity-agent` | Perplexity Agent | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `pioneer` | Pioneer | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `poe` | Poe | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `poolside` | Poolside | Documented setup/auth matrix row 39; HorizonCode still requires its own review |
| `privatemode-ai` | Privatemode AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `qihang-ai` | QiHang | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `qiniu-ai` | Qiniu | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `qvac` | QVAC | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `regolo-ai` | Regolo AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `requesty` | Requesty | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `routing-run` | routing.run | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `runinfra` | RunInfra | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `sakana` | Sakana AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `salad-cloud` | SaladCloud AI Gateway | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `sap-ai-core` | SAP AI Core | Documented setup/auth matrix row 40; HorizonCode still requires its own review |
| `sarvam` | Sarvam AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `scaleway` | Scaleway | Documented setup/auth matrix row 43; HorizonCode still requires its own review |
| `scnet-token-plan` | SCNet Token Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `scx-ai` | SCX.ai | Documented setup/auth matrix row 44; HorizonCode still requires its own review |
| `sensenova` | SenseNova (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `siliconflow` | SiliconFlow | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `siliconflow-cn` | SiliconFlow (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `snowflake-cortex` | Snowflake Cortex | Documented setup/auth matrix row 45; HorizonCode still requires its own review |
| `stackit` | STACKIT | Documented setup/auth matrix row 41; HorizonCode still requires its own review |
| `standardcompute` | Standard Compute | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `stepfun` | StepFun (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `stepfun-ai` | StepFun (Global) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `stepfun-ai-step-plan` | StepFun Step Plan (Global) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `stepfun-step-plan` | StepFun Step Plan (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `subconscious` | Subconscious | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `submodel` | submodel | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `synthetic` | Synthetic | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tempr` | Tempr | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tencent-coding-plan` | Tencent Coding Plan (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tencent-token-plan` | Tencent Token Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tencent-tokenhub` | Tencent TokenHub | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tensorx` | TensorX | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `the-grid-ai` | The Grid AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `thinkingmachines` | Thinking Machines | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tinfoil` | Tinfoil | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `togetherai` | Together AI | Documented setup/auth matrix row 46; HorizonCode still requires its own review |
| `tokengo` | TokenGo | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `tokenrouter` | TokenRouter | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `trustedrouter` | TrustedRouter | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `umans-ai` | Umans AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `umans-ai-coding-plan` | Umans AI Coding Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `unorouter` | UnoRouter | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `upstage` | Upstage | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `v0` | v0 | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `vancine` | Vancine | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `venice` | Venice AI | Documented setup/auth matrix row 47; HorizonCode still requires its own review |
| `vercel` | Vercel AI Gateway | Documented setup/auth matrix row 48; HorizonCode still requires its own review |
| `vispark` | Vispark | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `vivgrid` | Vivgrid | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `volcengine` | Volcengine Ark | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `volcengine-coding-plan` | Volcengine Ark Coding Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `vultr` | Vultr | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `wafer.ai` | Wafer | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `wallaby` | Wallaby | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `wandb` | CoreWeave | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `watsonx` | watsonx.ai | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `xai` | xAI | Documented setup/auth matrix row 49; HorizonCode still requires its own review |
| `xiaomi` | Xiaomi | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `xiaomi-token-plan-ams` | Xiaomi Token Plan (Europe) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `xiaomi-token-plan-cn` | Xiaomi Token Plan (China) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `xiaomi-token-plan-sgp` | Xiaomi Token Plan (Singapore) | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `xpersona` | Xpersona | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `zai` | Z.AI | Documented setup/auth matrix row 50; HorizonCode still requires its own review |
| `zai-coding-plan` | Z.AI Coding Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `zeldoc` | Zeldoc | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `zenifra` | Zenifra | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `zenmux` | ZenMux | Documented setup/auth matrix row 51; HorizonCode still requires its own review |
| `zhipuai` | Zhipu AI | Unknown: no matching named provider documentation; feed metadata is not auth evidence |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | Unknown: no matching named provider documentation; feed metadata is not auth evidence |

The feed schema also contains `env`, `npm`, provider `api`, and model
capability/cost fields. Those values are **not an authentication or adapter
authorization source**: `env` does not enumerate OAuth/device-code methods, and `npm`
is executable package selection in the upstream runtime. HorizonCode does not persist
or execute these as auth instructions or provider packages. The 51-row documentation
matrix below records documented auth/setup methods and separately reviewed sign-in
cases. A feed provider ID not covered by a documented method and local source review
remains `auth=unknown`, `protocol=unknown`, and
`availability=unavailable/review-required`. The full ID list is not a claim that every
provider's OAuth, terms, or legal status has been independently researched.

## Every named provider section in the pinned documentation

The 51 numbered entries below are the complete named sections in
[`providers.mdx`](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/web/src/content/docs/providers.mdx)
at the pinned OpenCode revision; `Custom provider` is recorded separately. The
official [live provider page](https://opencode.ai/docs/providers/) is volatile and
should be checked again before implementation. OpenCode describes this page as a
partial directory, so the complete dated provider-ID inventory above comes from the
dynamic feed snapshot, not this docs page. Go and Zen auth/setup are recorded
separately because they are outside these named sections.

Auth labels below mean “the pinned OpenCode docs/source describe this setup.” They do
not authorize HorizonCode to reuse OpenCode's client ID, token store, code, or
subscription path. For common API-key entries, the docs' own provider section is the
precise setup reference; provider-specific protocol and capability support still
requires a HorizonCode conformance record.

| # | OpenCode docs entry | Documented auth / setup class at review | HorizonCode status rule |
|---:|---|---|---|
| 1 | 302.AI | Provider API key | Separate API-key route; test protocol/capabilities |
| 2 | Amazon Bedrock | Bedrock bearer token or AWS credential chain (profile, access keys, shared credentials, role/web identity/instance credentials) | Use an explicit user-selected AWS identity chain; never copy OpenCode credentials |
| 3 | Anthropic | API key; Claude Pro/Max OAuth is described, but the same page explicitly says prohibited | API key may be considered; subscription OAuth stays unavailable/conflicted pending primary-source resolution and authorized HorizonCode registration |
| 4 | Atomic Chat | Local OpenAI-compatible endpoint; example has no separate credential | Local endpoint still passes endpoint/egress policy; “no key in example” is not proof of no auth |
| 5 | Azure OpenAI | API key or Microsoft Entra ID via Azure CLI | Distinct key and user-selected CLI identity methods |
| 6 | Azure Cognitive Services | API key | Separate endpoint/resource configuration and conformance |
| 7 | Baseten | Provider API key | Separate API-key route |
| 8 | Cerebras | Provider API key | Separate API-key route; source also has a supplemental plugin |
| 9 | Cloudflare AI Gateway | Account ID + gateway ID + Cloudflare API token | Model gateway route; never accept credentials/endpoints from model metadata |
| 10 | Cloudflare Workers AI | Account ID + Cloudflare API key/token | Distinct from AI Gateway |
| 11 | Cortecs | Provider API key | Separate API-key route |
| 12 | DeepSeek | Provider API key | Separate API-key route |
| 13 | Deep Infra | Provider API key | Separate API-key route |
| 14 | DigitalOcean | Browser OAuth (documented `genai:read`, `inference:query`) or Model Access Key/environment key | Own client registration and flow required; do not transplant OpenCode's OAuth client |
| 15 | Eden AI | Provider API key | Separate API-key route |
| 16 | FrogBot | Provider API key | Separate API-key route |
| 17 | Fireworks AI | Provider API key | Separate API-key route |
| 18 | GitLab Duo | OAuth or personal access token; self-hosted instances may require a customer-created OAuth app; `GITLAB_TOKEN` also documented | OAuth scope/registration, instance, and docs-vs-code conformance must be reviewed independently |
| 19 | GitHub Copilot | Copilot subscription device-code sign-in | Keep visible; availability requires HorizonCode's own authorized registered client and terms review |
| 20 | GMI Cloud | Provider API key | Separate API-key route |
| 21 | Google Vertex AI | Google ADC via gcloud CLI or service-account credentials, plus project/region | Use a documented, explicit cloud identity mechanism; never scrape credential files |
| 22 | Groq | Provider API key | Separate API-key route |
| 23 | Hugging Face | Inference Providers token with inference permission | Token scope and route capability must be recorded |
| 24 | Helicone | Helicone gateway API key; optional custom model/header config | Gateway route; custom headers remain user-controlled secret references |
| 25 | llama.cpp | Local OpenAI-compatible server endpoint; no credential specified in example | Local endpoint with explicit destination and conformance |
| 26 | IO.NET | Provider API key | Separate API-key route |
| 27 | LM Studio | Local OpenAI-compatible server endpoint; no credential specified in example | Local endpoint with explicit destination and conformance |
| 28 | Moonshot AI | Provider API key | Separate API-key route |
| 29 | MiniMax | Provider API key | Separate API-key route |
| 30 | Modal | Proxy token composed of token ID and secret | Store as one secret reference; avoid logging or splitting into telemetry |
| 31 | NVIDIA | API key; local NIM uses a custom base URL | Hosted and local routes are separate; local does not imply no egress |
| 32 | Nebius Token Factory | Provider API key | Separate API-key route |
| 33 | Ollama | Local OpenAI-compatible server endpoint; no credential specified in example | Explicit local endpoint and model/server capability test |
| 34 | Ollama Cloud | Cloud API key; the docs also require pulling model information locally | Distinct from local Ollama; test account/plan constraints |
| 35 | OpenAI | API key or ChatGPT Plus/Pro OAuth in OpenCode docs; pinned source implements browser PKCE and device-code paths | User-owned credentials and official terms are required; OpenCode client registration and auth storage are not reusable |
| 36 | OpenCode Zen | OpenCode API key | Separate product, credential, price, and route from Go |
| 37 | OpenRouter | Provider API key | Separate API-key route |
| 38 | LLM Gateway | Provider API key | Separate API-key route |
| 39 | Poolside | API key; organization-hosted deployment can use customer-supplied key/token and compatible endpoint | Hosted and private deployment are distinct routes |
| 40 | SAP AI Core | Service key with client ID/secret and service URLs | Treat service-key JSON as a secret; parse/validate fields without logging |
| 41 | STACKIT | Project auth token | Separate API-key/token route |
| 42 | OVHcloud AI Endpoints | API key | Separate API-key route |
| 43 | Scaleway | API key | Separate API-key route |
| 44 | SCX.ai | API key | Separate API-key route |
| 45 | Snowflake Cortex | Browser OAuth, manual PAT/bearer token, or JWT/environment configuration | Browser OAuth uses Snowflake's documented local application; independently verify client/consent support before implementing |
| 46 | Together AI | Provider API key | Separate API-key route |
| 47 | Venice AI | Provider API key | Separate API-key route |
| 48 | Vercel AI Gateway | Gateway API key | Gateway route, not an underlying-provider credential |
| 49 | xAI | SuperGrok device-code OAuth or API key | Subscription OAuth stays gated on a valid HorizonCode registration and terms |
| 50 | Z.AI | API key; Coding Plan is a selectable account/plan route | Record plan/service availability separately from key presence |
| 51 | ZenMux | Provider API key | Separate API-key route |
| — | Custom provider | User-defined compatible endpoint; optional API key/custom headers; OpenAI-compatible chat or Responses protocol | Custom endpoint is explicit user configuration and remains subject to SSRF/egress rules; never import remote endpoint configuration |

OpenCode Zen and Go are first-party products described outside the 51 named-section
directory: Zen uses its own API key; Go uses a user-pasted OpenCode Go API key after
subscription. The Go page at the supplementary source pin describes $10 and $40
monthly plans and two models marked free for a limited time. The model offer does not
make the Go subscription free or guarantee future eligibility, availability, quota,
or unrestricted use. Prices and offers are volatile.

## OpenCode Go directory and route-map drift (2026-09-28)

At 2026-09-28 16:30:48 UTC, a credential-free `GET https://opencode.ai/zen/go/v1/models` returned HTTP 200, 3,569 bytes, and SHA-256 `1464472961052aa41d454cce5c953d5fc3c68d7a2e19e95f7a6f41901d3b178a`. Its response had `object: "list"` and 43 `data[]` records with `id`, `object`, `created`, and `owned_by`. This is a dated observation; it does not prove that future directory requests will remain unauthenticated. It reported availability IDs only, not price, auth, protocol, or capability.

The same-time `models.opencode.ai/api.json` `opencode-go` provider record had 33 models. The live Go docs endpoint table mapped 30 model IDs to protocol endpoints; the `/models` endpoint returned 43 IDs. This is a material upstream drift condition. HorizonCode may show all 43 IDs as discovered but MUST leave an ID unavailable for inference until its local, versioned route map has an exact matching entry and conformance evidence. It must not infer a path or protocol from the model name, `owned_by`, `npm`, `api`, or feed presence.

### Every model ID in the Go `/models` response

| Model ID | Discovery status |
|---|---|
| `minimax-m3` | Documented route mapping present in current docs |
| `minimax-m2.7` | Documented route mapping present in current docs |
| `minimax-m2.5` | No current docs route mapping; keep unavailable/review-required |
| `kimi-k3` | Documented route mapping present in current docs |
| `kimi-k2.7-code` | Documented route mapping present in current docs |
| `kimi-k2.6` | Documented route mapping present in current docs |
| `longcat-2.0` | Documented route mapping present in current docs |
| `kimi-k2.5` | No current docs route mapping; keep unavailable/review-required |
| `glm-5.2` | Documented route mapping present in current docs |
| `glm-5.3-flash` | Documented route mapping present in current docs |
| `glm-5.3` | Documented route mapping present in current docs |
| `glm-5.1` | No current docs route mapping; keep unavailable/review-required |
| `glm-5` | No current docs route mapping; keep unavailable/review-required |
| `deepseek-v4-pro` | Documented route mapping present in current docs |
| `deepseek-v4-flash` | Documented route mapping present in current docs |
| `deepseek-flash` | No current docs route mapping; keep unavailable/review-required |
| `deepseek-v4.1-flash` | Documented route mapping present in current docs |
| `deepseek-v4-flash-vision-exp` | Documented route mapping present in current docs |
| `qwen3.7-max` | No current docs route mapping; keep unavailable/review-required |
| `qwen3.8-max` | Documented route mapping present in current docs |
| `qwen3.8-flash` | Documented route mapping present in current docs |
| `qwen3.7-plus` | Documented route mapping present in current docs |
| `qwen3.6-plus` | No current docs route mapping; keep unavailable/review-required |
| `qwen3.5-plus` | No current docs route mapping; keep unavailable/review-required |
| `mimo-v2-pro` | No current docs route mapping; keep unavailable/review-required |
| `mimo-v2-omni` | No current docs route mapping; keep unavailable/review-required |
| `mimo-v2.6-pro` | Documented route mapping present in current docs |
| `mimo-v2.6-flash` | Documented route mapping present in current docs |
| `space-bunny-free` | Documented route mapping present in current docs |
| `longcat-2.5-preview-free` | Documented route mapping present in current docs |
| `mimo-v2.5-pro` | Documented route mapping present in current docs |
| `mimo-v2.5` | Documented route mapping present in current docs |
| `hy4-preview` | Documented route mapping present in current docs |
| `hy3` | Documented route mapping present in current docs |
| `hy3-preview` | No current docs route mapping; keep unavailable/review-required |
| `gpt-5.6-luna` | Documented route mapping present in current docs |
| `grok-4.5` | No current docs route mapping; keep unavailable/review-required |
| `grok-4.7` | Documented route mapping present in current docs |
| `grok-4.6` | Documented route mapping present in current docs |
| `muse-spark-1.3-contributor` | Documented route mapping present in current docs |
| `muse-spark-1.2-contributor` | Documented route mapping present in current docs |
| `omen-alpha` | No current docs route mapping; keep unavailable/review-required |
| `gpt-6-luna` | Documented route mapping present in current docs |

### Current official documentation endpoint-map snapshot

The official Go docs currently map these model IDs to paths at `https://opencode.ai/zen/go/v1`. The path-to-protocol mapping belongs in locally versioned HorizonCode code, not remotely refreshed model metadata.

| Path | Local protocol adapter | Documented model IDs |
|---|---|---|
| `/responses` | OpenAI Responses | `grok-4.7`, `grok-4.6`, `gpt-6-luna`, `gpt-5.6-luna`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` |
| `/chat/completions` | OpenAI-compatible Chat Completions | `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `longcat-2.0`, `longcat-2.5-preview-free`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.5`, `mimo-v2.5-pro`, `hy4-preview`, `hy3`, `space-bunny-free` |
| `/messages` | Anthropic Messages | `minimax-m3`, `minimax-m2.7`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus` |

The current route table covers 30 IDs. The 13 directory IDs without a route entry are: `deepseek-flash`, `glm-5`, `glm-5.1`, `grok-4.5`, `hy3-preview`, `kimi-k2.5`, `mimo-v2-omni`, `mimo-v2-pro`, `minimax-m2.5`, `omen-alpha`, `qwen3.5-plus`, `qwen3.6-plus`, `qwen3.7-max`. This is an expected inventory drift finding, not a reason to guess. Both currently documented free/limited-time model IDs (`longcat-2.5-preview-free` and `space-bunny-free`) appear in the current directory and map to `/chat/completions`; their account eligibility and the offer must still be checked at live-test time.

The Go page currently describes a paid subscription tier even when model rows show zero marginal prices. The `GET /models` response does not establish that a model is free. For live acceptance, select a model only from the intersection of (a) the current Go directory, (b) a current official price/offer source, and (c) a locally supported and conformance-tested route. If that intersection is empty or the account rejects the model, report `not applicable`/`blocked`, never PASS.

## Pinned OpenCode code paths checked

At `083ed266e058dc3d2d1b377ff5540859d79de110`:

- Catalog schema, source URL, caching, refresh: `packages/core/src/models-dev.ts` and
  `packages/schema/src/models-dev.ts`.
- Provider resolution and SDK selection: `packages/opencode/src/provider/provider.ts`.
- Provider integration modules (all 32 filenames):
  `packages/core/src/plugin/provider/alibaba.ts`, `amazon-bedrock.ts`,
  `anthropic.ts`, `azure.ts`, `cerebras.ts`, `cloudflare-ai-gateway.ts`,
  `cloudflare-workers-ai.ts`, `cohere.ts`, `deepinfra.ts`, `dynamic.ts`,
  `gateway.ts`, `github-copilot.ts`, `gitlab.ts`, `google-vertex.ts`,
  `google.ts`, `groq.ts`, `kilo.ts`, `llmgateway.ts`, `mistral.ts`,
  `nvidia.ts`, `openai-compatible.ts`, `openai.ts`, `opencode.ts`,
  `openrouter.ts`, `perplexity.ts`, `sap-ai-core.ts`, `snowflake-cortex.ts`,
  `togetherai.ts`, `venice.ts`, `vercel.ts`, `xai.ts`, and `zenmux.ts`.
- Additional first-party auth/provider plugins: `packages/opencode/src/plugin/azure.ts`,
  `cerebras.ts`, `cloudflare.ts`, `digitalocean.ts`,
  `github-copilot/copilot.ts`, `openai/codex.ts`, `snowflake-cortex.ts`,
  and `xai.ts`.
- Request identity/session headers: `packages/opencode/src/session/llm/request.ts`.
- Public docs: `packages/web/src/content/docs/providers.mdx` and its separate Go
  content under `packages/web/src/content/docs/go.mdx`.

The OpenCode repository is MIT-licensed at this pin (`LICENSE`). This review reused
architecture observations and factual provider names only; HorizonCode did not copy
source code, authentication code, tests, icons, or provider assets. Any future code
reuse must separately pass `ARCH/05`'s license gate.

## Supplementary provider/API source review (2026-09-28)

The following source files were checked at exact commit
[`7f964bbb00e505178847e2c08721b0fff56208f9`](https://github.com/anomalyco/opencode/tree/7f964bbb00e505178847e2c08721b0fff56208f9).
This review verifies the named files and directory membership only; it is not a
second full line-by-line audit of every provider implementation.

| Upstream source | Observed behavior at the pinned commit | HorizonCode implication (proposed) |
|---|---|---|
| [`packages/core/src/models-dev.ts`](https://github.com/anomalyco/opencode/blob/7f964bbb00e505178847e2c08721b0fff56208f9/packages/core/src/models-dev.ts) | Defines the Models.dev feed schema and fetch/cache lifecycle. The default feed origin is `https://models.opencode.ai`; code supports OpenCode-specific URL/path overrides. It uses a five-minute on-disk freshness check, a cross-process file lock, temp-file-plus-rename writes, a 10-second request timeout, bounded transient retries, and a scheduled 60-minute refresh. | The observed cache/refresh pattern is useful reference, not a Horizon requirement copied verbatim. Horizon's remote metadata client must pin its allowed origin, validate a narrow inert projection, keep last-known-good data on refresh errors, expose freshness, and never execute a feed-provided package or trust feed-provided auth, endpoint, or header instructions. |
| [`packages/core/src/plugin/models-dev.ts`](https://github.com/anomalyco/opencode/blob/7f964bbb00e505178847e2c08721b0fff56208f9/packages/core/src/plugin/models-dev.ts) and [`packages/opencode/src/provider/provider.ts`](https://github.com/anomalyco/opencode/blob/7f964bbb00e505178847e2c08721b0fff56208f9/packages/opencode/src/provider/provider.ts) | Models.dev data is transformed into OpenCode's provider/model catalog and integration methods. When present, `npm` package names select AI SDK implementations; provider/model metadata also supplies APIs, capabilities, limits, pricing, and experimental request transforms. Provider code has native and bundled SDK routes plus provider-specific loaders. The provider directory still contains 32 TypeScript files at this commit. | Reuse the separation of catalog, provider identity, auth methods, and transport as an architectural pattern. Horizon uses a Rust-owned typed registry and native protocol adapters. It must not load the feed's `npm` package, dynamically execute remote integration metadata, or treat feed `env` names as proof that an auth flow is implemented. |
| [`packages/opencode/src/session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/7f964bbb00e505178847e2c08721b0fff56208f9/packages/opencode/src/session/llm/request.ts) | OpenCode request preparation supplies OpenCode-specific project, session, request, client, and User-Agent headers for provider IDs beginning with `opencode`; other providers get session-affinity headers. This is OpenCode's own runtime behavior, not a Go API contract for third-party clients. | For Go, send HorizonCode's own descriptive User-Agent and a stable opaque conversation-affinity value in the documented `x-opencode-session` header. Do not copy OpenCode's internal project/request/client identifiers, `opencode-cli` identity, auth store, or OAuth flow. Keep the header value stable only within the intended conversation and do not derive it from a secret or expose a local path. |
| [`packages/web/src/content/docs/providers.mdx`](https://github.com/anomalyco/opencode/blob/7f964bbb00e505178847e2c08721b0fff56208f9/packages/web/src/content/docs/providers.mdx) and [`packages/web/src/content/docs/go.mdx`](https://github.com/anomalyco/opencode/blob/7f964bbb00e505178847e2c08721b0fff56208f9/packages/web/src/content/docs/go.mdx) | The provider page remains a partial setup directory, not the exhaustive dynamic feed. The Go page separately documents subscription/API-key setup, required client identity and session header, endpoint/protocol mappings, model usage limits, privacy notes, and a limited-time free label for `longcat-2.5-preview-free` and `space-bunny-free`. It says client compatibility is not guaranteed to continue; HorizonCode is not named in the pinned validated-client list. | The live Go endpoint map is a reviewed local compatibility table, not a remotely refreshed routing instruction. Go model discovery can refresh, but an unknown ID stays unavailable until a Horizon release adds and verifies its explicit route. Treat plan, region, quota, privacy, and free-offer eligibility as volatile and visible to the user. |

The source feed's `npm` and endpoint fields are meaningful to OpenCode because its
runtime owns the corresponding SDK loaders. Their existence does not establish that
another client can safely or legally execute the same package, use the same auth, or
reach the same route. HorizonCode's selected direction is a **native Rust connector
against OpenCode Go's documented HTTP API**, with adapter code and the explicit
route-to-protocol table shipped in HorizonCode releases. Metadata refresh is a
separate, data-only operation. A HorizonCode updater may deliver reviewed connector
and route changes in a later signed application release; a model-feed refresh must
never replace executable adapter behavior. Active attempts retain their selected
provider, model, protocol, adapter version, route-map revision, and metadata digest.

## Focused provider/cache recheck at the 083ed pin

At `083ed266e058dc3d2d1b377ff5540859d79de110`, the follow-up fully read
`packages/core/src/models-dev.ts` (266 lines), `packages/core/src/plugin/models-dev.ts`
(183), `packages/core/src/plugin/provider.ts` (71),
`packages/core/src/plugin/provider/dynamic.ts` (31),
`packages/core/src/plugin/provider/openai-compatible.ts` (17),
`packages/core/src/plugin/provider/opencode.ts` (320),
`packages/opencode/src/auth/index.ts` (97), and
`packages/opencode/src/provider/auth.ts` (229). It read selected ranges, not all
2,094 lines, of `packages/opencode/src/provider/provider.ts`, plus ranges 358–407,
465–490, and 1220–1388 of `provider/transform.ts`; local endpoint documentation was
also checked. The later `7f964bbb…` supplementary review above remains a separate,
newer scoped source review, not a full provider-tree audit.

The feed is projected into executable OpenCode loaders, including package/SDK
selection. HorizonCode's accepted `DEC-060` intentionally takes only inert metadata
and uses its own Rust adapters, fixed origins, credential handling, and validated
protocol routes. Do not copy feed-provided `npm`, `env`, URL, header, or auth behavior
into a Horizon runtime adapter.

Prompt caching differs by provider path: selected paths mark cache breakpoints,
while selected SDK routes construct cache-affinity keys or require explicit opt-in.
This is evidence for adapter/model-level capability negotiation, not a universal
OpenAI-compatible behavior. Horizon's local OpenAI-compatible endpoints have no
cache capability until the concrete server/model pair passes request and usage
conformance. See `DEC-070`, `REQ-PROV-012`, and `ARCH/11` for the resulting
route-pinning and cache-accounting contract.

### Go connector test matrix for a future implementation

All rows below are **planned acceptance checks**, not test results. No Rust connector
exists on the evidence reviewed here, and this research pass made no authenticated Go
request or model-inference call.

| Layer | Case | Required result | Status / prerequisite |
|---|---|---|---|
| Unit/contract | Parse a captured `/zen/go/v1/models` fixture, including duplicate, malformed, oversized, and unknown records | Reject malformed input safely; show newly discovered IDs as unavailable until a reviewed local route exists; do not infer protocol from metadata | Planned; fixture only |
| Unit/contract | Compare the pinned local Go route table with the current documented endpoint table (30 mapped IDs) | Every enabled route has an exact model ID, endpoint path, protocol, and route-map revision; the 13 IDs absent from the 2026-09-28 docs mapping remain unavailable unless re-reviewed | Planned; refresh official docs before execution |
| Unit | Map `/chat/completions`, `/responses`, and `/messages` to the correct protocol-specific request and response parsers | Exact path and parser pairing; wrong-protocol/unknown model fails closed | Planned |
| Unit/security | Build Go headers and redact diagnostics | Send HorizonCode User-Agent plus stable opaque per-conversation `x-opencode-session`; do not send OpenCode-owned identity fields or credentials in logs, UI events, crash reports, or model context | Planned |
| Unit/security | Store, replace, revoke, and read the Go API key through the Horizon secret broker | Secret is never written to ordinary config, task events, or output; missing/revoked key yields a typed auth error | Planned; secret-broker implementation required |
| Integration fixture | Chat Completions streaming and non-streaming, tool calls, finish reasons, usage, cancellation, timeout, partial stream, malformed frame, and provider error | Correct normalized result or typed failure; cancellation closes the request; partial/unknown outcome is not reported as success | Planned; local mock server only |
| Integration fixture | Responses and Anthropic Messages protocol families | Preserve each documented protocol's required fields, streaming events, usage, and errors; no silent cross-protocol fallback | Planned; local mock server only |
| Recovery | Network loss after request send, 401/403, 429, 5xx, malformed body, and restart during stream | Do not retry a non-idempotent inference blindly; classify outcome as known or unknown; keep active attempt route/config pinned | Planned |
| Regression | Refresh metadata while an attempt is running and again after resume | The current attempt retains its prior exact route/adapter/model snapshot; only a newly admitted attempt observes refreshed metadata | Planned |
| Live-provider acceptance | Minimal synthetic prompt against `longcat-2.5-preview-free` and `space-bunny-free`, each on the currently documented route | Each model returns a valid response through the native connector with correct model identity and usage accounting; report the account/plan, date, model ID, route revision, and observed charge/usage | Planned only when a user-authorized Go credential and eligible account exist; limited-time offers may disappear. If unavailable, mark blocked/not applicable, never PASS. |
| Live-provider safety | Check Go account eligibility, current free label/offer, privacy terms, region, and usage before and after the smoke call | No unrelated repository/user data is sent; respect current model privacy terms; stop on unexpected charge, consent requirement, quota, or policy change | Required prerequisite to each live smoke; no live call made in this pass |

The word “free” in the two live-smoke target names is not a stable acceptance
condition. At the 2026-09-28 source pin, the official page labels both as limited-time
free models while Go itself has paid subscription plans. The test must verify current
eligibility and the user's account's actual billing/usage state before sending a
request. A failed or unavailable free model must not trigger an automatic fallback to
a paid model.

## HorizonCode evidence and refresh policy

- A provider discovery row may exist while its integration status is `not_implemented`,
  `blocked`, `unavailable`, or `unknown`. Only exact route-conformance evidence can
  mark the adapter tested. Never equate model-catalog presence with provider support.
- Provider auth methods are a locally reviewed registry keyed to a pinned source/doc
  revision. Remote models data can refresh display/model facts; it cannot create or
  enable OAuth, populate endpoint URLs, select an `npm` package, add headers, or choose
  credential sources.
- OAuth/device paths require the provider's documented flow and a valid HorizonCode-
  owned registration, with PKCE/state/least scopes and secret broker support. If the
  vendor requires a different application's identity or the provider's terms conflict,
  keep that method visible but unavailable. For API-key routes, the user supplies
  their own credential through the secret broker.
- Go is a separate native Rust connector and its separate model list refreshes
  dynamically. Each request uses HorizonCode's own User-Agent and stable opaque
  conversation affinity ID in `x-opencode-session`. Do not use OpenCode's
  `opencode-cli` client ID, auth file, OAuth state, User-Agent, or credential.
- Store the selected provider/model/protocol/adapter/auth method/capability digest and
  metadata digest as an immutable route snapshot per attempt. Metadata updates change
  future selection only; active attempts stay pinned.
- `/providers` exposes catalog presence, discovered models, auth-method coverage,
  required setup, exact unavailable reason, source/freshness date, adapter/conformance
  status, and a per-provider “report stale listing” path. It must not prompt for a
  credential until the method is locally enabled and validated.

## Sources and known limits

- [OpenCode Providers](https://opencode.ai/docs/providers/) — live page checked
  2026-09-28; currently describes 75+ providers and local models and presents a
  partial directory of the 51 named entries above plus Custom. The global model feed
  snapshot has 225 IDs/8,253 models (SHA-256 above).
- [OpenCode Go](https://opencode.ai/docs/go/) — live page checked 2026-09-28; lists
  the documented endpoint mappings and two limited-time free models. Credential-free
  `GET /zen/go/v1/models` returned 43 IDs in the snapshot above; the API and docs
  counts/routes can drift. Go requires an eligible subscription/API key for inference,
  asks clients to use their own User-Agent and stable `x-opencode-session`, and says
  validated-client compatibility is not guaranteed indefinitely. HorizonCode is not
  listed among the currently named validated clients; even after a successful
  HorizonCode acceptance probe, do not claim upstream validation or future compatibility.
- [Original pinned OpenCode source](https://github.com/anomalyco/opencode/tree/083ed266e058dc3d2d1b377ff5540859d79de110)
  — exact source pin for the original integration-file map above.
- [Supplementary pinned OpenCode source](https://github.com/anomalyco/opencode/tree/7f964bbb00e505178847e2c08721b0fff56208f9)
  — exact source pin for the provider/catalog/API files linked in the supplementary review; not a claim that every integration implementation was re-reviewed.

This is not a legal opinion, live provider-access test, current price/quota guarantee,
or proof of HorizonCode compatibility. Recheck provider terms, OAuth registration,
model availability, and service limits before each implementation and acceptance
run. HorizonCode has not yet made a live Go API request or performed model inference.
