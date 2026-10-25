# DeepSeek Harness (dsh) and Cordis — HLD/LLD research for HorizonCode

Status: research evidence only. Not architecture authority. Nothing here overrides `arch_V1/`, its topic owners, `AGENTS.md`, or the capability registry. No product code was changed, no dependency was added, no paid API call was made.

Research date: 2026-10-24. All local clones live under `repo_take/research-src/` (repository-contained), per root `AGENTS.md`.

---

## 0. Scope resolution — what "DeepSeek Harness" actually is

The name is ambiguous. Primary sources resolve it:

> "DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI. It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in *A Programming Paradigm for Spatiotemporal Composability*."
> — `repo_take/research-src/deepseek-harness/README.md:5-7`

Independent confirmation from the vendor's own API documentation: the page <https://api-docs.deepseek.com/quick_start/pricing> lists **"DeepSeek Harness"** under *Agent Integrations*, alongside Claude Code, Codex and OpenCode, linking to `deepseek-harness.github.io`. So dsh is a first-party product, not a community wrapper.

**Resolved artifact:** `github.com/deepseek-ai/deepseek-harness` — a TypeScript/Node monorepo (pnpm workspaces, ~19,188 files, MIT, developer preview) that ships the `dsh` CLI and `@deepseek-ai/dsh-*` packages, with `web`, `headless`, `sdk`, `sdk-minimal` and `acp` profiles. It is simultaneously (a) the reference client for the DeepSeek model API and (b) a Cordis-based plugin platform.

**Rejected as a different thing** (all checked against the live org listing on 2026-10-24, 45 public repos):

| Candidate | What it is | Why it is not "the DeepSeek Harness" |
|---|---|---|
| `deepseek-ai/DeepInfer` | "High-performance, large-scale inference framework for DeepSeek models" (Python, Apache-2.0) | Serving/inference engine, not an agent harness; no agent loop, tools, sessions or plugins. |
| `deepseek-ai/DeepSeek-V3`, `-R1`, `-Coder`, `-Coder-V2`, `-VL2`, `-Math`, `-Prover-*` | Model releases with inference/eval guidance | Model repos, not harness products; no agent loop, tool layer, session model or plugin system. |
| `deepseek-ai/awesome-deepseek-agent`, `awesome-deepseek-integration` | Curated link lists | Directories, not implementations. |
| `deepseek-ai/dsh-libreoffice-kit` (MPL-2.0), `dsh-node-addon-require-builtin` (MIT) | "An internal component used by DeepSeek Harness" | Component libraries of dsh, not the harness. |
| "A harness around DeepSeek models" built by third parties (Claude Code / Codex / OpenCode / OpenClaw / Hermes integrations) | Third-party clients of the DeepSeek API | Different class of artifact. Section 3 below documents the model/API contract such a harness must implement, so the report is useful either way — but it is **not** what the DeepSeek org publishes. |
| `deepseek-ai/DeepSeek-OCR`, `Janus`, `DeepGEMM`, `3FS`, `DeepEP`, `FlashMLA`, `smallpond`, `Engram`, etc. | Infrastructure/model research | Unrelated to agent harness design. |

**There is no separate DeepSeek "eval harness" repository.** Evaluation design lives *inside* dsh: recorded-session snapshots (`snapshots/`), owner-local expected output, real-API e2e, and performance gates (`benchmarks/`). See §4.8.

Note for the provenance owner (I must not edit it): `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md:10` already pins `deepseek-harness` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. Current HEAD is `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; the older pin is stale by a large margin (the repo is in developer preview and self-declares breaking changes). Pin refresh is a §42 decision, not taken here.

---

## 1. Provenance register (this research)

| # | Source | Exact reference | License | Yield | Status |
|---|---|---|---|---|---|
| P1 | `deepseek-ai/deepseek-harness` | `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (`git rev-parse HEAD`, 2026-10-23 push) | MIT (`LICENSE`, 21 lines); third-party notices in `THIRD_PARTY_NOTICES.md` (313 lines) | Whole-harness architecture: loop, tools pipeline, session log, sandbox, subagent, compaction, spill, persistence, eval, plus the DeepSeek wire extensions | SOURCE-READ |
| P2 | `cordiverse/cordis` | `35fdc969e4b6c48c48ed44717c7a018324e4dd88` (2026-10-22), core `cordis@4.0.0-rc.12`, loader `@cordisjs/plugin-loader@1.0.0-rc.9`, hmr `1.1.2`, include `1.2.0` | MIT (Copyright 2021-present Shigma) | Context/service/effect/coeffect core, loader, HMR, patch layering | SOURCE-READ |
| P3 | DeepSeek Harness vendored Cordis | `vendor/README.md` manifest: `cordis@4.0.0-rc.7` at `56b3d4f725681cf4556c1a8695a709cc3b6eed74`; `include/group/hmr/logger-console` at `abb0a307cb1d3b0947f455d590cf5ba922d4caa4`; `cosmokit 1.8.1`, `schemastery 3.18.0` | MIT, upstream LICENSE preserved per package | **24 documented local modifications**, including fiber reentrancy hardening and lazy config resolution | SOURCE-READ (manifest + mod log only) |
| P4 | DeepSeek API docs — Context Caching | <https://api-docs.deepseek.com/guides/kv_cache> fetched 2026-10-24 | Vendor docs (no code license implied) | Disk KV cache prefix-unit rules, hit accounting fields, best-effort/eviction | DOCUMENTED |
| P5 | DeepSeek API docs — Models & Pricing | <https://api-docs.deepseek.com/quick_start/pricing> | Vendor docs; **prices are volatile** | `deepseek-flash` / `deepseek-v4-pro`, 1M context, 384K max output, cache-hit vs cache-miss pricing, peak/off-peak, concurrency | DOCUMENTED |
| P6 | DeepSeek API docs — Thinking Mode | <https://api-docs.deepseek.com/guides/thinking_mode> | Vendor docs | Toggle/effort matrix, `reasoning_content` replay law (400 if omitted with tools), disabled sampling params | DOCUMENTED |
| P7 | DeepSeek API docs — Tool Calls | <https://api-docs.deepseek.com/guides/tool_calls> | Vendor docs | `strict` beta schema subset, mid-conversation insertion limits per API format | DOCUMENTED |
| P8 | DeepSeek API docs — Chat Completions reference | <https://api-docs.deepseek.com/api/create-chat-completion> | Vendor docs | Request limits, `finish_reason` set, streaming/usage rules, tool name grammar, `tool_choice` thinking restriction | DOCUMENTED |
| P9 | DeepSeek API docs — Error Codes / Rate Limit | <https://api-docs.deepseek.com/quick_start/error_codes>, <https://api-docs.deepseek.com/quick_start/rate_limit> | Vendor docs | 400/401/402/422/429/500/503; concurrency limits; `user_id` KV isolation; SSE keep-alive; 10-minute pre-inference close | DOCUMENTED |
| P10 | DeepSeek API docs — FIM (Beta) | <https://api-docs.deepseek.com/guides/fim_completion> | Vendor docs | Prefix+suffix completion, `/beta` base, 4K max tokens, non-thinking only | DOCUMENTED |
| P11 | arXiv 2608.25512, *A Programming Paradigm for Spatiotemporal Composability* (Shi, Zhang, Cui; PKU + DeepSeek-AI; 92pp) | <https://arxiv.org/abs/2608.25512> | arXiv non-exclusive distribution license (not a code license) | Formal framing only: revertible **effects** + reactive **coeffects** = "context paradigm" | DOCUMENTED (abstract only; full text **not read** → theory claims UNVERIFIED) |

Not used, deliberately: `repo_take/opencode`, `repo_take/oh-my-pi`, `repo_take/jcode`, `repo_take/re-sandbox` (owned by other agents / out of scope). No npm package installation, no build, no test run, no model call.

Disk: clones occupy ≈230 MB (`deepseek-harness` 228 MB incl. `.git`, `cordis` 1.5 MB). No build outputs created. Volume has 830 GB free. No processes, ports or worktrees created.

---

## 2. Why this artifact matters to HorizonCode

dsh solves the same shape of problem HorizonCode solves — a coding agent whose capabilities are contributed by replaceable parts — but with the **opposite authority choice**: dsh puts *everything*, including policy, sandbox and the agent loop, inside one in-process Cordis plugin tree with no privileged core (`docs/architecture.md:7-11`). HorizonCode puts managed authority in Rust (Guard/ExecutionHost/OwnerLog) and treats plugins, MCP, LSP and hooks as non-authorities (`arch_V1/README.md:17-24`).

That inversion is exactly what makes dsh valuable: it is a high-fidelity, fully source-readable specimen of the *plugin-composition* half that HorizonCode deliberately keeps weak, plus a first-party specimen of the *DeepSeek wire contract* that HorizonCode must implement for its provider lane. What transfers is mechanism and ordering law; what must not transfer is authority placement.

---

## 3. DeepSeek model / API contract layer (what any harness must implement)

This section stands alone: it is the contract for HorizonCode's DeepSeek provider route regardless of whether dsh is ever consulted again.

### 3.1 Models, limits, price surface

| Fact | Value | Source |
|---|---|---|
| Model ids | `deepseek-flash` (DeepSeek-V4.1-Flash-1017), `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | P5 |
| Base URLs | `https://api.deepseek.com` (OpenAI format), `https://api.deepseek.com/anthropic` (Anthropic Messages format) | P5, P8 |
| Context length | 1M tokens | P5 |
| Max output | 384K (`max_tokens` 1..393216; default 8K non-thinking, 64K thinking, 128K at `max` effort) | P5, P8 |
| Thinking | enabled by default, default effort `high` | P5, P6 |
| Vision | `deepseek-flash` yes, `deepseek-v4-pro` no | P5 |
| FIM | non-thinking only, 4K max, `/beta` base | P10 |
| Concurrency (per account) | 2500 (flash) / 500 (v4-pro); HTTP 429 when exceeded | P5, P9 |
| Cache hit price (flash) | $0.003/1M off-peak, $0.006/1M peak | P5 |
| Cache miss price (flash) | $0.15/1M off-peak, $0.30/1M peak | P5 |
| Output price (flash) | $0.60/1M off-peak, $1.20/1M peak | P5 |
| Peak window | 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays; everything else is off-peak (half price) | P5 |

Derived, load-bearing conclusion: **a cache hit is ~50× cheaper than a miss on `deepseek-flash` (30× on `deepseek-v4-pro`)**. Prefix stability is not a micro-optimization; it is the dominant cost variable in a multi-step coding loop, where the same large prefix is re-sent every step.

### 3.2 Context caching — the actual matching rule

DeepSeek's cache is a **disk KV cache, on by default**, with no documented client-side cache-control markers (contrast: Anthropic `cache_control` breakpoints).

- Each request constructs cache state. A later request hits only if it **fully matches a persisted cache-prefix unit** (P4).
- Prefix units are persisted at three kinds of boundary: (1) **end of user input** and **end of model output** for every request; (2) a **detected common prefix** across multiple requests; (3) **fixed token intervals** for long inputs/outputs (P4).
- Consequence A: `A+B` then `A+B+C` hits `A+B`. Consequence B: `A+B` then `A+C` does **not** hit, but the system then persists `A`, so a third request `A+D` hits `A` (P4, Examples 1–2).
- Cache is **best effort**, construction takes seconds, and unused entries are cleared "usually within a few hours to a few days" (P4).
- Cache is **isolated per `user_id`**, which is also used for content-safety and scheduling isolation; the id must match `[a-zA-Z0-9\-_]+`, ≤512 chars, and must not contain user PII (P9).
- Reporting fields: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, and `prompt_tokens_details.cached_tokens` (equal to hit tokens); `prompt_tokens = hit + miss` (P4, P8).

**Harness obligations that follow:**

1. **Byte-stable prefix.** Order prompt segments so that identity/persona/static rules/tool schemas come first and volatile facts (clock, cwd, git status, file lists) come last, ideally in a trailing user-role context message. Any byte change before a boundary loses reuse from that token.
2. **Never gratuitously rewrite the leading system message.** Either keep it frozen, or use a provider route that reads the *latest* `system` message anywhere in `messages` as the effective prompt, so the changed prompt can be **appended after cached history** (dsh calls this `systemPromptUpdate: in-history`; see §4.3).
3. **Freeze the tool block per step.** Tool schemas are prefix content; registering/disposing a tool or changing order invalidates reuse from the first changed schema token (dsh documents this explicitly: `packages/core/tools/README.md:171-172`). Add tools mid-conversation via provider-supported tool-addition records, not by editing the schema block.
4. **Compaction is a cache reset.** Summarizing rewrites history and therefore the prefix. Compact at pressure, not speculatively; prefer appending a summary as a new surface node over rewriting early nodes when the protocol allows it.
5. **Report hits honestly.** Cache read/write tokens must be carried as disjoint usage counters, never inferred; "no observed cache" is a valid state (`arch_V1/37-RUNTIME-SERVICE-LLD.md:1737-1741`, §37.14).
6. **Off-peak scheduling** (background jobs, batch evals, index builds) is a real 2× lever, but it must be an explicit, user-visible policy, not a silent delay of interactive work (HorizonCode §21.8 cost protection).

### 3.3 Thinking / reasoning replay — the sharpest trap

| Rule | Detail | Source |
|---|---|---|
| CoT field | `reasoning_content`, sibling of `content` | P6 |
| Replay **with** `tools` | **All** prior turns' `reasoning_content` must be passed back; omitting it returns **HTTP 400**. Applies even to turns with no tool call. | P6 |
| Replay **without** `tools` | Reasoning must not be passed back; if passed it is ignored and not concatenated | P6 |
| Effort mapping | `minimal→low`, `low→low`, `medium→high`, `high→high`, `xhigh→high`, `max→max`, `ultra→max`; default `high` | P6, P8 |
| Toggle fields | OpenAI: `thinking.type` + `reasoning_effort`; Anthropic: `output_config.effort` (and `reasoning.effort: none` disables) | P6 |
| Sampling | thinking ignores `temperature`, `presence_penalty`, `frequency_penalty`; `top_p` fixed 1.0 in non-thinking and 0.95–1.0 in thinking (per-model differences) | P6, P8 |
| Tool choice | `required` and named-tool choices are **unsupported in thinking mode → 400** | P8 |
| Deprecated | `frequency_penalty` / `presence_penalty` no longer supported (silently ignored) | P8 |

**Harness obligations:** persist reasoning blocks *and* any provider signature verbatim in the durable log; bind replay metadata to the exact model that produced it; degrade (drop signatures, keep text/tool history) rather than fail when metadata is foreign or corrupt; and make "tools present in this request" a stable property of the turn, because it flips the replay obligation. dsh implements exactly this: `packages/llm/llm-deepseek/src/replay.ts:29-64` (envelope `deepseek-messages` v1, model-bound, block-count and block-type checks, degrade callback) and `serialize.ts:26-39` (reasoning → `thinking` block with `signature`).

### 3.4 Tool calls — format constraints and repair

| Constraint | Detail | Source |
|---|---|---|
| Tool name grammar | `a-z A-Z 0-9 _ -`, ≤128 chars, unique per request | P8 |
| Arguments | JSON **string**; "the model does not always generate valid JSON, and may hallucinate parameters" — validate before executing | P8 |
| `strict` mode | Beta only (`base_url=.../beta`), per-tool `"strict": true`; every `object` must set **all** properties `required` and `additionalProperties: false`; supported types: object/string/number/integer/boolean/array/enum/anyOf, plus `$def`/`$ref`; **unsupported**: `minLength`, `maxLength`, `minItems`, `maxItems` | P7 |
| Mid-conversation insertion | Anthropic `/messages` and Responses API support inserting tool calls *and* `system` messages mid-conversation; **Chat Completions does not support inserting tool calls** (system messages only) | P7 |
| Turn sequencing | Tool results must immediately follow their calls; duplicate call ids or unmatched results are request errors | dsh `serialize.ts:131-146` (adapter-enforced; consistent with P8) |

**Harness obligations:** generate two schema profiles (general JSON Schema for the standard route, strict-compatible subset for the beta route) and never emit unsupported keywords on the strict route; validate arguments before Guard (so Guard sees normalized arguments, not model text); convert invalid arguments into a normal tool-error result that keeps the turn alive; repair history so every `tool_use` has a matching `tool_result` before sending, including when a step crashes mid-batch.

### 3.5 Streaming event shape

Two valid shapes; a harness must pick one and settle it durably.

**OpenAI Chat Completions (default):** `data:`-only SSE frames, `data: [DONE]` terminator; deltas with `choices[].delta.{content,reasoning_content,tool_calls[]}`; `stream_options.include_usage` makes every chunk carry `usage` (null except the last); the last chunk before `[DONE]` carries the whole-request usage with **no new content** and a non-null `finish_reason`. `finish_reason ∈ {stop, length, content_filter, tool_calls, insufficient_system_resource, aborted}` (P8).

**Anthropic Messages (what dsh uses at `/anthropic`):** `message_start` (carries usage), `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta` (stop_reason + usage), `message_stop`. Delta subtypes: `text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta` (`partial_json`). dsh maps stop reasons `end_turn|stop_sequence→stop`, `tool_use→tool-calls`, `max_tokens→max-tokens` and turns anything else into `MALFORMED_RESPONSE` (`packages/llm/llm-deepseek/src/translate.ts:90-97`). Tool JSON is accumulated per block and only parsed at `message_stop`, **except** when `max_tokens` truncated it (`translate.ts:140-158`). `message_stop` without settled blocks or a stop reason, or a stream that ends before `message_stop`, is `STREAM_CLOSED` (`translate.ts:147-165`).

**Harness obligations:** treat "settled" as an explicit state (finish reason + all blocks closed); never treat `length` as success; distinguish `insufficient_system_resource` (provider-side capacity, retryable) from `content_filter` (not retryable) and `aborted` (caller); apply an idle-read timeout (dsh default 300 s) and a total budget; persist one settled outcome per attempt (see §4.4).

### 3.6 Rate limit, keep-alive, error taxonomy

- Limits are **concurrency**, not QPS: a request occupies one slot from send until response complete; account-level across API keys; 429 on excess (P9).
- Keep-alive: non-streaming responses emit blank lines, streaming responses emit SSE comments `: keep-alive`; parsers must tolerate both. If inference has not started within **10 minutes**, the server closes the connection (P9).
- HTTP error codes: 400 invalid format, 401 auth, 402 insufficient balance, 422 invalid parameters, 429 rate limit, 500 server, 503 overloaded (P9).
- dsh normalizes these into a stable adapter taxonomy that is worth mirroring: `AUTH` (401/403), `QUOTA` (402), `RATE_LIMIT` (429), `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST` (400/422), `SERVER` (5xx), `HTTP_<status>` otherwise; plus `TRANSPORT`, `ABORTED`, `TIMEOUT`, `STREAM_CLOSED`, `MALFORMED_RESPONSE`, `EMPTY_RESPONSE`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `UNSUPPORTED_REASONING_EFFORT`, `UNSUPPORTED_CONTENT`, `IMAGE_OFFLOAD_REQUIRED`, `REQUEST_EXTENSION` (`packages/llm/llm-deepseek/README.md:113-127`).
- `EMPTY_RESPONSE` (terminal stop, zero content blocks) is retryable; `MALFORMED_RESPONSE` / `STREAM_CLOSED` are not silently retryable without a new attempt record.

### 3.7 Usage accounting (billing correctness)

dsh's `TokenUsage` contract is the right shape and HorizonCode should not diverge from it:

> Counts are **DISJOINT**: `inputTokens` is uncached input only; cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three). Adapters whose providers fold cache hits into a total prompt count (DeepSeek's `prompt_tokens`) subtract them out.
> — `packages/llm/llm/src/types.ts:168-186`

So: `prompt_tokens = cacheRead + cacheWrite? + uncachedInput`. A harness that stores `prompt_tokens` as "input" will overstate cost by up to 50× on cached turns.

### 3.8 FIM and other surfaces

FIM (`/beta/completions`) takes `prompt` + optional `suffix`, max 4K output, non-thinking only (P10). It is a completion feature (editor inline completion), **not** an agent tool-call path; do not route agent mutations through it. Responses API and Anthropic-format compatibility exist (P5), which is why dsh can speak Messages at `/anthropic` and still be a DeepSeek client.

---

## 4. dsh harness architecture (source-verified)

### 4.1 Composition: profiles, bundles, patch layers

A running `dsh` is a **plugin tree composed at boot from ordered layers** (`docs/architecture.md:13-35`):

- A **profile** (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) is a named composition stored in the Harness home; it lists bundles, out-of-tree plugins, and the user's `cordis.patch.yml`.
- A **bundle** is a distribution format for Cordis config rows plus the code they mount; it declares itself in `package.json` under a `dsh` field (`dsh.profile` / `dsh.bundle`).
- Layers apply to an empty entry list: profile bundles → profile patch → home patch → `--patch` overlays. A patch targets a row **by id** and replaces its whole config or inserts rows.
- `dsh --profile web --dump-config` prints the exact tree; `scripts/verify-application-entrypoints.ts` forbids any Node application path that bypasses the `dsh` launcher.

Source: `packages/boot/app-boot` (profile runner), `cordis/packages/include/src/patch.ts:72-140` (`PatchIndex` + `applyPatches` on a deep clone, with an **entry/key ownership index** so the UI can tell whether a value came from the file, a patch, or an embedded insert); dsh vendors the same package as `vendor/include/`.

This is a genuinely good composition model: **declarative rows + id-addressed overrides + ownership provenance**, no code fork per deployment.

### 4.2 The loop: turn → step → tools → settle

Entry points: `packages/core/agent-loop/src/agent.ts` `ReactLoopAgent`.

- `turn()` (`agent.ts:319-426`): appends durable `turn/start`, loops over proposed steps, calls `preStep` (waterfall) which may reject or rewrite, appends `step/start`, runs `step()`, guarantees `step/end` in `finally`, and always appends `turn/end` with a typed reason (`blocked|completed|max-tokens|aborted|error`) — including on failure (`agent.ts:412-419`).
- On step failure it **records missing tool results** before rethrowing, so the log never contains a dangling call (`agent.ts:367-378`, `ToolCallRecovery`).
- `step()` (`agent.ts:428-539`): prepares the bound call, projects the system prompt through `ctx.systemPrompt.project(...)` with per-node intents, admits user messages once, builds the request, then streams through `AssistantStreamAttempt`. On a stream failure after start, it settles either `assistant/message` (if content was produced) or `assistant/attempt` (log-only), and aggregates a settlement failure with the original error (`agent.ts:492-533`).
- The durable-vs-live split is explicit: `turn/*`, `step/*`, `system/message`, `user/message`, `assistant/message`, `assistant/attempt`, `tool/*` are **session events**; `agent/assistant-stream` frames are process-local (`docs/architecture.md:79-120`).

### 4.3 Prompt assembly and the cache-preserving system update

`packages/core/system-prompt` owns one ordered prompt per step:

- Sections carry `order`; ascending order, ties broken by code-unit name (`packages/core/system-prompt/README.md:54-58`). First-party orders are sparse and fixed: identity `−1000`, persona prefix `0`, guidance, env suffix `10000`, Web surface `10100`, persona suffix `10200` (`README.md:142`).
- Tool order is canonicalized before dispatch so registration order cannot leak into the prefix (`src/index.ts:227-254`); `toolOrder` supports one `<unlisted-tools>` rest marker.
- Runtime facts are separate **context** providers, re-read at `refreshContext()` before admission, and become sourced user-role snapshots — not system text (`README.md:68`, `src/index.ts` `SystemPromptProjection`).
- Cache law is stated as a first-class contract (`README.md:154-156`): prefix-stable while the rendering is unchanged; on a route without `systemPromptUpdate`, a changed prompt is **consolidated at node 0** and loses reuse from the first changed token; on a route declaring `in-history`, the loop **appends** the changed prompt after cached history so the prefix through that history stays reusable.

That last mechanism is the single most valuable DeepSeek-specific trick in the repo, and it is confirmed from the provider side: DeepSeek reads the latest `system` message at any position as the complete effective system prompt (`packages/llm/llm-deepseek/README.md:53`), and `serialize.ts:106-117` implements exactly that (system messages after position 0 become `systemUpdates` flushed after the preceding user/tool-result turn).

### 4.4 Session log: model-visible ⟺ logged

`packages/core/session` is an append-only typed event log; everything else derives from it (`packages/core/session/README.md:8-11`, `docs/architecture.md:122-133`).

- `deriveMessages()` projects the log to model history incrementally and cached (`src/index.ts:988-1029`).
- Surface events (`system/message`, `developer/message`, `user/message`, `assistant/message`, `tool/result`) require a `surfaceOp`: `append` or `replace{startSeq,endSeq}`. Compaction therefore **hides** nodes without deleting them (`README.md:52-56`).
- `assistant/message` embeds the exact compact timed stream that produced the content; `assistant/attempt` retains failed/retried/cancelled/stream-error attempts **without** entering model history (`docs/architecture.md:124-131`).
- `request/header` stores a full canonical snapshot of the non-history request envelope with reason `initial|resume|change|series`, so any request can be reconstructed from the log; same-series steps and retries inherit it (`README.md:104-107`, `src/request-header.ts`).
- Plugins that change message content must register a **pure projection**; a missing definition rejects append/restore (`README.md:44-48`).

### 4.5 Tool registry and execution pipeline

Two layers: `ctx.tools` (registry + prompt projection) and an executor (`native` or `ptc`). The policy pipeline is fixed and documented as a graph (`docs/tool-execution-pipeline.md:1-40`):

```
tool/call (logged before execution)
→ tools/pre-execute waterfall        allow | deny | ask
→ ctx.approval (one-shot; absent/unanswerable ⇒ deny)
→ registered monotonic guards        deny or abstain; cannot allow
→ tools/execute waterfall            around-dispatch: timeout, retry, metrics
→ tool body
→ tools/post-execute waterfall       replace content, block, attach context
→ definition.finalizeContent         last content-only invariant
→ tools/result                       observe-only, frozen outcome
→ tool/result (single model-facing outcome)
```

Source proof: `packages/core/tools/src/pipeline.ts:190-233` (gate → ask → `checkGuards` → dispatch), `contracts.ts:384-391` (`ToolGuard = (exec) => string | undefined`, "guards have no allow"), `batch.ts:1-2,80,109-111,188-192` (exclusive calls form barriers; parallel calls use a bounded rolling pool, reclassified before start).

Cancellation is cooperative and quiescent: `ABORTED_BEFORE_DISPATCH` vs `ABORTED`, with more specific denials/timeouts preserved (`packages/core/tools/README.md:126-128`).

### 4.6 Sandbox, approval, spill, compaction, subagent

| Concern | Mechanism | Source |
|---|---|---|
| Sandbox | `ctx.sandbox` backend with modes `read-only`, `workspace-write`, `danger-full-access`; **if the mode cannot be enforced the call fails `SANDBOX_UNAVAILABLE` instead of running unconfined**; after a denial the model may request one strictly wider mode for human approval; same-world confinement only (not a VM) | `packages/sandbox/sandbox/src/index.ts:25-33`, `src/escalation.ts:30-42`, `packages/sandbox/sandbox/README.md:12` |
| Approval | `ctx.approval` seam, per-session policy `ask`/`never`, one-shot grants, **missing or failed answerers resolve `unavailable` and fail closed**, every request/outcome recorded in the session audit log, child sessions may inherit a policy override marked `source: 'delegation'` | `packages/interaction/user-approval/README.md:12-26`, `src/index.ts:12-60` |
| Spill | `ctx.spillStore.saveText(owner, text)` returns an opaque locator + exact byte count + retrieval guidance; policy plugin replaces oversized tool results with bounded previews; no retention/replace/search API | `packages/spill/spill/README.md:10-20` |
| Compaction | Triggers on token pressure at `agent/pre-step` and on canonical context-overflow errors; optional tool-result pruning first; retry only if pruning/summarization **advanced the surface replacement generation**; one extra model request, summary text only | `docs/agent-lifecycle.md:60-70`, `packages/compaction/compaction-basic/README.md:12` |
| Subagent | Provider seam: `spawn-in-process`, `fork-in-process`, `dsh-sdk`, `acp`, `codex`, `claude-code`; local spawn/fork children keep durable sessions, one-shot externals do not; child inherits parent origin metadata and permission roots, keeps its own cwd | `packages/subagent/subagent/README.md:12-20` |

### 4.7 Persistence

- JSONL provider: `session.jsonl[.zstd]` for v0, `session.vN.jsonl[.zstd]` from v1 on; committed generation paths are **never renamed, replaced or deleted**; open selects the numerically highest canonical generation, refuses a future version, and composes the adjacent `vN→vN+1` migration chain once (`docs/architecture.md:126`).
- Publish is **exclusive**: write temp, `link(tmp, final)`, unlink temp, fsync the directory — explicitly *not* `rename()`, because `rename` would silently clobber a concurrent writer (`packages/session/session-persistence-jsonl/src/index.ts:1299-1312`; `generation.ts:125-150`).
- Write-behind durability barrier: `ctx.sessions.flush(session)` dispatches an awaited checkpoint to every persistence listener (`packages/core/session/README.md:86-88`).

### 4.8 Evaluation design

dsh's eval stack is tiered and, notably, **not** a separate benchmark product:

| Tier | What it proves | Source |
|---|---|---|
| Unit + coverage gate | per-file 100% on `packages/*/*/src`; each registry must have an **HMR-safety test** (dispose contributor, assert cleanup) | `docs/testing.md:9-15` |
| Real-API e2e | boots a shipped `dsh` profile, sends one prompt, **inspects the world** (re-read files, re-run commands), not the agent's self-report; asserts untouched files byte-identical | `docs/testing.md:37-45` |
| Owner-local expected output | keyless CLI/process expectations | `docs/testing.md:17` |
| Performance benchmarks | user-path gates in `benchmarks/` (`session-open`, `agent-continuation`, `active-stream-reconnect`, `long-session-browser`, `terminal-io`, …), timed under plain Node | `docs/testing.md:19`, `benchmarks/` |
| Recorded-session snapshots | a real recorded session replays as both input and expected persisted result, across `headless`, `sdk`, `acp` and `web`; mutating scenarios diff a complete `workspace.expected/` tree | `docs/testing.md:21` |

Key doctrine worth importing: *"Verify the world, not the self-report"* and *"a guard only guards if the regression fails it"* (introduce the regression, watch red, revert) — `docs/testing.md:47-53`.

---

## 5. Cordis LLD (upstream `cordis@4.0.0-rc.12`, commit `35fdc96`)

Framework thesis (paper abstract, P11): two composability dimensions — **temporal** (every context transformation carries an inverse the runtime holds = *revertible effects*) and **spatial** (every context change is classified against a component's declared dependencies to drive activation = *reactive coeffects*). Cordis unifies both in one context type.

All paths in §5 are relative to the **cordis** clone (`repo_take/research-src/cordis`), not dsh. dsh's vendored copy (`vendor/`, rc.7 + 24 patches) has different line numbers.

### 5.1 Context tree

- A `Context` is a prototype-chained object; `extend(meta)` creates a child, `isolate(name, label)` shadows the isolation map for one service name, `intercept(name, config)` shadows the interception map (`packages/core/src/context.ts:55-77`).
- The root context is a `Proxy` (`ReflectService.handler`) that resolves property reads through **declared injections**: reading `ctx.foo` without `inject: ['foo']` throws `cannot get property "foo" without inject` (`packages/core/src/reflect.ts:94-124`, message at `:103`).
- `locate(ctx, name)` walks the fiber chain and stops at isolation boundaries, so a service resolves to the nearest provider **in the same realm** (`reflect.ts:66-91`).

### 5.2 Service registry and isolation

- A service registers itself in its constructor: `ctx.reflect.provide(name, self, check)` (`packages/core/src/service.ts:20-37`).
- `provide` is **an effect**: it allocates a per-name symbol in the root isolate map, refuses a second registration for the same symbol (`service "X" has been registered at <fiber>`), notifies dependents, and on disposal waits for dependents before removing the provision (`reflect.ts:202-238`).
- Isolation is symbol-keyed: `{ isolate: true }` gives an entry a private realm (`name#entryId`), `{ isolate: 'label' }` gives a shared named realm (`name@label`), with garbage collection when no entry references the realm (`packages/loader/src/config/isolate.ts:16-76,142-159`).
- Interception is layered: each context's intercept map inherits from its parent; `Service[resolveIntercept]` merges the chain plus a caller-supplied inject value via `mergeIntercept` (`service.ts:53-70`). The loader applies an entry's `intercept` config before start (`entry.ts:169-179,370`).

### 5.3 Plugin lifecycle and dependency-reactive activation

- States: `PENDING`, `LOADING`, `ACTIVE`, `FAILED`, `DISPOSED`, `UNLOADING` (`packages/core/src/fiber.ts:90-97`).
- **Activation is a function of dependency availability.** A fiber's epoch is `revision:uid(impl1):uid(impl2)…`; `_refresh()` recomputes it, `_setEpoch()` compares and drives `_reload()` or `_unload()` (`fiber.ts:395-424`). Service registration/removal calls `notify()`, which re-checks every fiber that injects the name and refreshes its epoch (`reflect.ts:240-259`). This is the "reactive coeffect" in code: no manual boot ordering, no event bus for readiness.
- A **failed** fiber only recovers through `update()`, which clears the error and restarts (`fiber.ts:411-412,509-529`); config updates pass through an `internal/update` waterfall, so a listener may veto the restart (`fiber.ts:519-522`).
- Disposal clears `uid` (so new effects throw `INACTIVE_EFFECT`), unloads the registry entry, then awaits `inertia` to quiesce (`fiber.ts:184-205`).

### 5.4 Effects and disposables (teardown ordering law)

- `Fiber.effect(execute, label)` runs the body, collects every returned disposer, and returns a **single-shot** disposer; async bodies chain disposal after settlement; a failed setup disposes what it already collected and rethrows (`fiber.ts:285-350`).
- Disposal order is **reverse registration order** (`disposables.splice(0).reverse()`, `fiber.ts:291-304`; `DisposableList.clear()` returns reversed values, `utils.ts:27-31`).
- **Unload waits for dependents before disposing provisions**: `while ([...this.provisions].some(impl => impl.dependents.size)) await …`, then disposes effects, then releases providers (`fiber.ts:457-491`). Comments state the reason explicitly: dependents may still use the service during their own teardown.
- dsh *hardened* exactly this area for reentrancy (vendored patch #6): owner-list wrapper registered before setup, unload begun from inside setup awaits setup, effect creation rejected while `UNLOADING`, cleanup-time registrations cannot escape the unload snapshot (P3, `vendor/README.md` mod 6).

### 5.5 Config and schema validation

- `Plugin.Config` is a **StandardSchemaV1** schema (`registry.ts:69-100`); `resolveConfig` validates synchronously at load, throws `ValidationError` with normalized issue paths, and explicitly rejects async validators (`fiber.ts:46-58`, error formatting `:16-40`).
- The loader interpolates `!!js` expressions in `config` and in the entry's `disabled` field only, after declared injections activate, and relocates validation errors back to the YAML row/column (`packages/loader/src/index.ts:74-113`, `entry.ts:94-104,290-297`).
- Config equality is strict and reference-aware, with a `volatile` concept so that framework-owned references do not force remounts (P3 mod 22; `equalExceptVolatile`).

### 5.6 Loader: entries, groups, patches

- Entry options: `id`, `name`, `config`, `group`, `disabled`, `inject`, `intercept` (+ loader extension `isolate`) (`entry.ts:8-16`; `isolate.ts:6-14`).
- `Entry.update()` is a 4-step reconcile: merge options → resolve/inject interpolation → blocked/disabled check → diff and either rebuild (import/name change) or hot-patch the context (`entry.ts:218-257`).
- Entries with `inject` mount an **outer fiber** that imports the module first and starts the inner fiber only after import succeeds (`entry.ts:35-46,339-358`), which is how a failed import never leaves a half-mounted plugin.
- Disabling a group cascades to children through `_parentDisabled()` (`entry.ts:114-137`).
- Patch application is a pure function over a deep clone with an ownership index; entries inserted by an earlier patch are indexed as they are added, so a later patch can configure or disable them (P3 mod 11; `cordis/packages/include/src/patch.ts:72-140`).

### 5.7 Hot module replacement

`packages/hmr/src/index.ts` implements a three-stage, mostly-transactional reload:

1. **Classify** changed files into accepted/declined by walking the dependent graph; `node:` and `node_modules` are excluded (`:256-309`).
2. **Re-import the module graph all-or-nothing**, backing up and clearing both the ESM `loadCache` and CJS `require.cache`; on failure it restores both caches (`:375-423`).
3. **Unload then reload per fiber, concurrently**; skip fibers with inactive ancestors or replaced entry roots; on reload failure it logs and **leaves the plugin failed, exactly as on a cold start — no rollback**, with the next file change retrying it (`:425-505`, comment at `:497-499`).

This is an honest failure model: the *module graph* is transactional; the *plugin instance* is not. It matches the framework's own "revertible effects" claim only for the effects a plugin registered — not for external side effects.

### 5.8 Failure/rollback summary

| Failure | Behavior | Source |
|---|---|---|
| Invalid config | Load fails with path-annotated `ValidationError`; entry traced to YAML location | `fiber.ts:46-58`, `entry.ts:290-297` |
| Import failure | Outer fiber stops; inner plugin never starts; error logged; entry stays for retry | `entry.ts:35-46,299-309` |
| Plugin apply throws | Fiber → `FAILED`, error logged, runtime retained, recovery only via `update()` | `fiber.ts:438-455`, `entry.ts:319-327` |
| Dependency lost | `notify()` re-checks injecting fibers; epoch change unloads dependents first | `reflect.ts:240-259`, `fiber.ts:381-406` |
| HMR reload throws | No rollback; stays failed until next change | `hmr/src/index.ts:496-502` |
| Config file invalid at runtime | Running tree retained (include keeps last good parse) | P3 mod 8 |

---

## 6. Transfer analysis for HorizonCode

Verdict key: ADOPT = take the mechanism nearly as-is; ADAPT = take the mechanism, change authority/placement; REFERENCE-ONLY = design input, no implementation; REJECT = do not take. Effort S ≤ 1 day, M ≤ 1 week, L > 1 week (implementation + tests, excluding review).

| # | Mechanism | Where it lives (path:line) | What it would buy us | HorizonCode owner / § | Conflict risk vs Guard / one registry / one session owner / no hidden paid fallback | Verdict | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Disk KV cache prefix-unit semantics + 50× hit/miss price delta | P4 (kv_cache), P5 (pricing) | Correct cost model; cache-aware prompt compilation; honest hit reporting | §30.11 caching law, §30.21 cache ledger, §37.30.2 `PrefixCacheAdapterV1`, §37.14 `CacheObservationAdapterV1` | None. Must never fabricate hits or silently change provider | ADOPT | S |
| 2 | `systemPromptUpdate: in-history` — append changed system prompt after cached history instead of rewriting node 0 | `packages/core/system-prompt/README.md:154-156`; `packages/llm/llm-deepseek/README.md:53,85,181`; `serialize.ts:106-117` | Preserves prefix cache across prompt changes in a long tool loop; biggest single cost win | §30.11, §37.30.2, §15.2 | Low: needs an explicit per-route capability flag; must not alter pinned prefix bytes mid-turn (§37.14) | ADAPT | S |
| 3 | Ordered prompt sections + canonical tool ordering + volatile facts as late context | `system-prompt/README.md:54-58,68,142`; `src/index.ts:227-254` | Deterministic, byte-stable prefix; fewer accidental invalidations | §30.26 compile tiers, §37.30.3 `RepoContextAnchorBuilderV1` | None | ADAPT | S |
| 4 | Reasoning replay envelope: model-bound, block-aligned, degrade-don't-fail | `packages/llm/llm-deepseek/src/replay.ts:29-64`; `serialize.ts:26-39` | Prevents 400s and cross-model signature contamination in tool loops | §15.2 provider turn, §15.18 adapter boundary | None. Log stays the single truth | ADOPT | S |
| 5 | Reasoning replay *obligation* when tools are present (omit ⇒ 400) | P6 | Correct multi-step tool loops; prevents silent history mutation | §15.2, §14.24 request pin | None | ADOPT (as hard adapter rule + negative test) | S |
| 6 | Strict-mode schema subset for tool schemas (all-required, `additionalProperties:false`, no min/maxLength/minItems) | P7 | Fewer malformed tool calls on the beta route; precise schema generation | §15.18, §33.5 tool naming | Low: must not weaken general-schema validation | ADAPT (dual profile) | S |
| 7 | Tool pipeline ordering: extensible pre-execute → one-shot approval (fail-closed) → **monotonic deny-only** guards → around-dispatch → post → finalize → observe-only | `docs/tool-execution-pipeline.md:10-40`; `packages/core/tools/src/pipeline.ts:190-233`; `contracts.ts:384-391`; `packages/interaction/user-approval/README.md:12-20` | A precise, testable ordering law inside one Guard path; denies can never be re-permitted | §14.2 Guard decision, §14.3 effect pipeline, §37.2 registry | **Medium**: any reading that makes plugin order the authority violates Rust Guard supremacy. Adopt the *ordering* only, inside one Guard/ExecutionHost | ADAPT | S |
| 8 | `finalizeContent` last + `tools/result` observe-only frozen outcome | `tools/README.md:126-128`; `tool-execution-pipeline.md:18-22` | Result integrity: no listener can mutate what the receipt/model/UI see after settlement | §14.3 receipt, §31.22 activity cards | None | ADAPT | S |
| 9 | Approval: absent answerer ⇒ `unavailable` ⇒ deny; one-shot grants; audit events in the session log; child policy seeded with `source:'delegation'` | `packages/interaction/user-approval/README.md:12-26`; `src/index.ts:12-60` | Fail-closed interactive approval with auditable provenance | §14.2 durable approval, §29.13 delegation depth | Medium: HorizonCode approval is a durable Rust record; keep that, borrow the fail-closed + seed semantics | ADAPT (semantics only) | S |
| 10 | Sandbox mode ladder + escalate-one-step-only-with-approval + `SANDBOX_UNAVAILABLE` instead of unconfined | `packages/sandbox/sandbox/src/index.ts:25-33`; `src/escalation.ts:30-42` | A clean policy statement for "never silently unsandboxed" | §14.5 sandbox profile, §21.3 permission modes | Low; HorizonCode's OS confinement is stronger, so borrow the *ladder and failure* rule only | ADAPT (policy text) | S |
| 11 | Session generations + `link()` exclusive publish + adjacent migrations + refuse future version | `docs/architecture.md:126`; `session-persistence-jsonl/src/index.ts:1299-1312`; `generation.ts:125-150` | No-clobber publication and safe reader/writer coexistence | §04 state/events, §18 operations | None; OwnerLogV2 is already stronger (digests, head cursor) | REFERENCE-ONLY | S |
| 12 | `request/header` snapshots (`initial`, `resume`, `change`, `series`) for reconstructable requests | `packages/core/session/README.md:104-107`; `src/request-header.ts`; `agent.ts:438-472` | Any request reconstructable from the log; retries don't re-assemble or re-admit users | §14.23 request-bound context integrity, §30.24 request-bound revision, §15.21 | Low: adds log volume; must be bounded | ADAPT | M |
| 13 | `assistant/attempt` (log-only settlement) vs `assistant/message` (embeds stream) | `docs/architecture.md:124-131`; `agent.ts:492-533` | Truthful recovery: failed attempts visible for audit, absent from model history | §15.13 recovery, §04 events | None | ADAPT (keep stream as digest/ref, not inline blob) | M |
| 14 | Compaction as surface *replacement* at pre-step; retry only if replacement generation advanced | `docs/agent-lifecycle.md:60-70`; `packages/compaction/compaction-basic/README.md:12` | Context survival without deleting history; no retry loops that cannot help | §30.3 `/compact`, §30.4 pressure recovery, §15.20 | None | ADAPT | M |
| 15 | Spill: save oversized text, return locator + exact bytes + retrieval hint | `packages/spill/spill/README.md:10-20` | Stops context flooding from logs/terminal output while keeping full text retrievable | §30.17 terminal/log retrieval, §31 artifacts | Low: needs retention/GC owner (dsh explicitly has none — we must add one) | ADAPT | S/M |
| 16 | Per-agent scope with **intersect-only** restriction and disposal | `packages/core/tools/README.md:86-88`; `packages/core/scope/README.md:10-14` | Agent/preset capability narrowing without a second registry | §29.2 AgentProfileV2, §33.20 exposure, §37.2 one registry | **Medium**: must be a monotone intersection over the canonical registry — never an alternate registry | ADAPT | M |
| 17 | Advisory repeat-tool reminder at 3/5/8 exact repeats | `packages/guard/repeat-tool-reminder/README.md:10-12` | Cheap escape from stuck loops without hard-blocking legitimate repeats | §21.6 recovery coordinator | Low: advisory only; must not be sold as safety | ADOPT | S |
| 18 | PTC: `run_code` transport + ordered sub-calls through the same pipeline, parent token, denials as binding rejections, call/result adjacency | `docs/tool-execution-pipeline.md:30-34`; `tools/README.md:130` | Conformance reference for HorizonCode's V1 CodeMode | §29.22, §37.24 `CodeMode` | Medium: sub-calls must stay individually Guard-authorized | REFERENCE-ONLY → ADAPT when §37.24 lands | M |
| 19 | Runtime npm plugin install via pnpm subprocess | `packages/boot/plugin-manager/README.md:10-14` | Marketplace UX | §14.8 extension trust | **High**: supply chain, remote mutation, non-Guarded install | REJECT for V1 | — |
| 20 | `dsh_session_log` — upload the full session suffix (cwd, prompts, content, tool args/results, failed attempts) to the model endpoint | `docs/deepseek-llm-api-wire-extensions.md:74-160` | None for us; it is provider telemetry | §14.9 audit/privacy, §05 security | **High**: exfiltration of user code/prompts; also a hidden second egress | REJECT | — |
| 21 | Revertible effects + dependent-quiescent teardown + per-registry disposal proof | `packages/core/src/fiber.ts:285-350,457-491`; `docs/testing.md:11` | Leak-free plugin/service lifecycle; testable disposal invariant | §13 composition (TS plugin services), §31 client plugins | Low if scoped to first-party plugin lifecycle; must not become an effect authority | ADAPT (V1 narrow) | M |
| 22 | Isolate / intercept realms + service shadowing | `context.ts:65-77`; `reflect.ts:202-238`; `loader/src/config/isolate.ts:58-140` | Per-preset service substitution without forking the tree | §29.2 presets, §16 settings composition | **Medium**: implicit resolution + proxy magic obscures ownership; adjacent to "one session owner" | REFERENCE-ONLY (post-V1) | L |
| 23 | Loader entry tree + id-addressed patch layers + ownership index | `loader/src/config/entry.ts:218-257`; `cordis/packages/include/src/patch.ts:72-140`; `docs/architecture.md:13-35` | Declarative, overridable composition without code forks; provenance of every config value | §16 settings/composition, §13 | Low for config composition; high if it ever selects effect authority | REFERENCE-ONLY (post-V1) | M |
| 24 | HMR: transactional module graph, non-transactional plugin instance, no rollback | `packages/hmr/src/index.ts:256-309,405-505` | Honest dev-loop failure semantics; no false "rolled back" claims | post-V1 dev experience, §31 | Low | REFERENCE-ONLY | M |

### 6.1 The one law worth stating in a topic owner

From rows 7 and 21, distilled:

> Within a single Guard- and ExecutionHost-authorized tool execution, policy may be **extended** before the decision (hooks, permission, sandbox), but after the decision only **deny** is permitted: no later listener, wrapper, or post-policy may convert a denial back into permission. Teardown runs in reverse registration order, and a provider is not disposed until every dependent has unloaded.

HorizonCode already implies the first sentence in §14.2/§14.3; dsh gives a fully enumerated pipeline and a testable shape for it. The second sentence is genuinely new for the TS/plugin side and is cheap to adopt.

---

## 7. Ranked top-6

Selection rule: value × transferability, weighted to V1 (a V1 item must be wireable into an existing HorizonCode owner without creating a second authority). Rank 7–12 follow as second tier.

| Rank | Item | Phase | Why it ranks here | Owner | Effort |
|---|---|---|---|---|---|
| 1 | **Cache-aware prompt layout + `in-history` system update + honest cache observation** (rows 1–3) | **V1** | 50× price delta per cached input token on the default model; directly makes long tool loops affordable; no authority conflict; HorizonCode already owns §30.11/§30.21/§37.30.2/§37.14 | §30.11, §30.21, §37.30.2, §37.14, §15.2 | S |
| 2 | **DeepSeek provider conformance profile** (rows 4–6, plus §3.5–3.7): reasoning replay law, model-bound replay envelope, dual schema profiles, disjoint cache usage, finish/error taxonomy, keep-alive + idle timeout | **V1** | Without it, multi-step tool loops 400 or silently lose reasoning; without disjoint usage, cost telemetry is wrong by up to 50× | §15.2, §15.18, §14.24, §37.14 | M |
| 3 | **Tool-pipeline ordering law** (rows 7–10): pre-execute → approval (fail-closed) → monotonic deny-only guards → around → post → finalize → observe; `SANDBOX_UNAVAILABLE` never unconfined | **V1** | Security-correctness, cheap, and resolves an ambiguity HorizonCode currently leaves implicit ("can a hook widen?") — answer: never | §14.2, §14.3, §14.5, §37.2 | S |
| 4 | **Registration-as-reversible-effect + dependent-quiescent teardown + per-registry disposal proof** (row 21) | **V1** | Directly de-risks HorizonCode's TS plugin/service layer (Core plugins, hooks, client plugins); testable invariant; dsh found and fixed real reentrancy bugs here | §13 composition, §31 client plugins, §32 test catalog | M |
| 5 | **Reconstructable request envelope + attempt settlement** (rows 12–13): log a canonical non-history request header per series; log-only failed attempts; retries reuse the frozen assembly | **V1** | Recovery/UNKNOWN truth, cache integrity, and reproducible provider disputes; matches §14.23/§30.24 intent with a concrete record shape | §14.23, §30.24, §15.13, §15.21 | M |
| 6 | **Cordis spatial composability as the post-V1 extension model** (rows 22, 23, 24): isolate/intercept realms, entry-tree + id-addressed patch layers with ownership provenance, three-stage HMR with honest no-rollback | **post-V1** | Highest-leverage *design* import for a plugin ecosystem, but it collides with V1's single-runtime/one-registry constraints; must be introduced for non-authoritative UI/config plugins only, after V1 authority is frozen | §16 (settings/composition), §29.2 (presets), §31 (client plugins) | L |

**Second tier (rank 7–12):** 7 compaction-as-replacement + replacement-generation-gated retry (V1, §30.3/§30.4, M); 8 per-agent intersect-only scope masks (V1, §29.2/§33.20, M); 9 spill store with locator + retrieval hint **plus a retention/GC owner dsh lacks** (V1, §30.17, S/M); 10 advisory repeat-tool reminder (V1, §21.6, S); 11 PTC conformance details (V1 when §37.24 CodeMode lands, §29.22, M); 12 JSONL-style generation/exclusive-publish reference (V1 only as a cross-check on OwnerLogV2, S).

---

## 8. REJECT list

| Rejected | Reason |
|---|---|
| **Cordis (or any in-process plugin tree) as the effect/policy authority** | Violates "one canonical capability registry", "every mutation crosses the same Guard/ExecutionHost", and Rust ownership of effects/leases/receipts. dsh can do this because it has no privileged core; HorizonCode cannot. |
| **Runtime npm plugin installation as a product capability** (`plugin-manager`, pnpm subprocess) | Supply-chain and remote-mutation surface; requires §14.8 extension trust, signature/provenance, approval and rollback that V1 does not have. |
| **`dsh_session_log` provider upload** (full session suffix, cwd, system prompt snapshots, tool args/results, failed attempts) | Exfiltrates user code and prompts to a model endpoint as a side effect of inference; hidden second egress; incompatible with §14.9/§05 and with "no hidden paid/external fallback". If ever needed for an explicit interop contract, it must be opt-in, bounded, redacted, and Guard-authorized. |
| **`tools/pre-execute` cannot rewrite arguments** (dsh's documented limitation) | Not acceptable for HorizonCode: Guard must authorize the *normalized* arguments that actually execute. dsh itself flags this as a known desync risk (`packages/core/tools/README.md:197`). |
| **Advisory guards presented as safety controls** | `repeat-tool-reminder` is loop hygiene, not policy. Never map it to a §32 security acceptance case. |
| **Embedding the full provider stream inside every assistant message** | dsh does this for replay fidelity; HorizonCode's OwnerLogV2 uses digests/refs. Adopt the *attempt settlement* idea, not the inline stream blob (log growth, duplication). |
| **Same-world sandbox as the V1 isolation story** | dsh says plainly it is host-kernel confinement, and recommends containers/microVMs for real isolation. HorizonCode's Linux/cgroup + ExecutionHost path is already the stronger claim; borrowing dsh's mode names is fine, borrowing its isolation claim is not. |
| **Code copy from dsh or Cordis into product code** | dsh is a complete rival harness in developer preview with self-declared breaking changes; Cordis is a general framework whose implicit proxy/injection model would fight HorizonCode's explicit typed boundaries. MIT permits copying; product-architecture policy does not. Behavior/algorithm adaptation only, recorded in §42. |
| **Cordis `Context` proxy ergonomics wholesale** (`ctx.foo` magic, `ctx.get` topology sensitivity, shadow def-site/use-site distinction) | Excellent for a framework with no privileged core; in HorizonCode it would obscure which owner authorized what, and it makes "who can read this service" a runtime property instead of a reviewed one. Reference for spirit, reject for surface. |
| **`ctx.approval` as the durable approval record** | HorizonCode approval must be a durable, single-use, hashed challenge in Rust (§14.2); dsh's is a session-log projection. Borrow fail-closed and seeding semantics only. |
| **dsh's `x-deepseek-harness-*` identity headers and anonymous Harness-home UUID** | Adds vendor-visible, stable per-install identity to every model request. HorizonCode has not authorized that egress; any such id would have to be opt-in, opaque and documented in §05/§14.9. |
| **Treating `content_filter`, `aborted`, `length` as retryable success** | Wrong semantics; see §3.5. |

---

## 9. Unknowable / not found

| Item | Status |
|---|---|
| A DeepSeek-published **eval harness** as a separate repo | **Not found.** Evaluation is embedded in dsh (`snapshots/`, `benchmarks/`, `docs/testing.md`). No published benchmark scores were reproduced here. |
| Whether the older §42 pin `5badb15009ae` corresponds to a materially different architecture | **Not checked.** Only current HEAD `22ddee37` was read. Pin refresh is a §42 decision. |
| Full formal content of arXiv 2608.25512 (92 pp) | **Not read** — abstract only. Effect/coeffect formalism, theorems and the observational-equivalence claim are therefore UNVERIFIED beyond the abstract. |
| `docs/persistence-catalog.md` (9,242 lines), `docs/module-graph.md` (1,843), `docs/capability-seams.md` (738) | **Partially read.** Per-event schema details, full module graph and every seam role are not verified here. |
| `cordis.io` documentation site | **Not fetched.** Source (rc.12) was used as authority instead; the site may describe a different version. |
| Exact behavior of dsh's vendored Cordis `4.0.0-rc.7` + 24 patches | **Partially verified.** Upstream rc.12 source was read; the vendored copy is 783 lines vs upstream 530 in `fiber.ts`, so **upstream line citations do not map to the vendored file**. The patch log (P3) was read, not each patch's diff. |
| Live provider behavior: actual cache hit rates, `Retry-After` headers, 429 body shape, real streaming quirks | **Unverified.** No paid API call was made (forbidden). Everything in §3 is DOCUMENTED or SOURCE-READ, not live-verified. |
| DeepSeek Responses API and Anthropic-compatibility details beyond the Messages path dsh uses | **Not read.** Only referenced as existing. |
| dsh plugin ecosystem (`dsh-plugin` GitHub topic), marketplace contents, third-party plugin quality | **Not surveyed.** |
| Whether Cordis rc.12 has finer-grained signal-level reactivity | **No.** Activation is epoch/dependency-driven; there is no fine-grained reactive graph in `packages/core/src`. If someone means "cordis v3 reactivity", that is a different codebase and is not covered. |
| Windows/macOS behavior of dsh sandbox backends and JSONL publication | **Not read** (`sandbox-windows-acl`, `win32.ts` only seen by name). Irrelevant to V1 Linux/WSL-first, relevant post-V1. |
| Legal review of adapting dsh algorithms (as opposed to copying code) | **Out of scope here.** MIT is permissive, but `THIRD_PARTY_NOTICES.md` (313 lines) was not audited file-by-file; any actual extraction needs §42 review. |

---

## 10. Reproduction

```sh
# from repo root
mkdir -p repo_take/research-src
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git repo_take/research-src/deepseek-harness
git clone --depth 1 https://github.com/cordiverse/cordis.git repo_take/research-src/cordis
git -C repo_take/research-src/deepseek-harness rev-parse HEAD   # 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
git -C repo_take/research-src/cordis rev-parse HEAD             # 35fdc969e4b6c48c48ed44717c7a018324e4dd88
```

Key files to read first, in this order:

1. `deepseek-harness/docs/architecture.md` (169 lines) — whole-system map.
2. `deepseek-harness/docs/deepseek-llm-api-wire-extensions.md` — what dsh adds on the wire (and why we reject the session-log field).
3. `deepseek-harness/packages/llm/llm-deepseek/README.md` §"Endpoint and wire format", §"Failures and recovery", and the KV-cache paragraph at line 181.
4. `deepseek-harness/packages/core/system-prompt/README.md` §"KV Cache effect" (line 154).
5. `deepseek-harness/packages/core/tools/src/pipeline.ts:190-233` + `docs/tool-execution-pipeline.md`.
6. `cordis/packages/core/src/fiber.ts:285-350,457-491` and `packages/core/src/reflect.ts:202-259`.

No builds, tests, servers, ports, or model calls were run. Nothing outside `reports/research/deepseek-harness-cordis.md` and `repo_take/research-src/` was written.
