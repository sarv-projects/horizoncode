# 30 — Context engineering, repository intelligence and local/small-model runtime

**Status:** normative V1 target. This chapter makes low-token, low-latency operation a first-class architecture requirement rather than an optimization pass.

## 30.1 Principles

1. The model sees **only what it needs for the current decision**.
2. Canonical history and durable Goal/Run state are not deleted to make context smaller.
3. Context assembly is deterministic, inspectable and budgeted against the **actual selected model**.
4. Repository discovery prefers structured symbol/navigation tools before broad file reads.
5. Local and very small models are valid first-class selections. HorizonCode degrades features honestly instead of silently routing to a bigger or paid model.
6. Tool schemas and skill bodies are themselves context cost and are loaded progressively.
7. Context cleanup must be reversible at the view/projection level.
8. Every compaction/prune operation exposes what changed and why.

## 30.2 ContextLedger and user-visible context bar

One `ContextService` compiles provider requests. A read-only `ContextLedger` projection exposes the current model-visible plan.

```ts
type ContextEntryKindV2 =
  | "system"
  | "goal"
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "file"
  | "symbol"
  | "artifact"
  | "image"
  | "document"
  | "skill"
  | "memory"
  | "subagent_result"
  | "environment"

type ContextEntryV2 = {
  entryId: Id<"ContextEntryId">
  kind: ContextEntryKindV2
  sourceRef: string
  sourceRevision?: string
  trust: "system" | "user" | "workspace" | "external"
  bytes: number
  tokens: {
    value: number
    kind: "exact" | "estimated" | "unknown"
    tokenizerId?: string
  }
  included: boolean
  inclusionReason?: string
  protected: boolean
  cacheClass?: "static" | "history" | "turn" | "attachment" | "none"
  freshness?: string
  digest: Digest
}
```

Context bar segments:
- system/control;
- durable goal/criteria;
- conversation;
- files/symbols;
- tool results/artifacts;
- skills/memory;
- attachments/media;
- reserved model output.

UI shows absolute tokens where known, percentage of model context, whether token count is exact or estimated, and entries removed by the next cleanup operation.

## 30.3 Context operations have different semantics

### `/trim`

Deterministic removal of expendable paired payloads, primarily old verbose tool output where an artifact/reference remains.

- no model call;
- never removes Goal/spec, unresolved NeedsYou, current tool batch, unacknowledged effect, or required evidence;
- preserves a short typed placeholder and artifact ref;
- ideal first pressure response.

### `/prune`

Relevance-based removal of stale natural-language/history entries.

- may use a small model or deterministic scorer;
- default interactive mode shows a preview with reasons;
- protected recent user turns and pinned entries cannot be pruned;
- accepted prune record stores source range/digest so history search can recover it.

### `/compact`

Creates a bounded summary artifact over an older history range.

- summary has provenance and covered cursor range;
- original history remains canonical/retrievable;
- changed Goal/constraints after summary creation are not retroactively folded into it;
- compaction quality can be verified against protected facts.

### `/clear`

Starts a new model-visible context epoch while preserving Thread history. It does not erase the session. History Search can retrieve prior messages and artifacts later.

## 30.4 Automatic context pressure recovery

Do not hard-code one universal 75% trigger. Derive thresholds from model context, maximum requested output, tool/schema reserve and provider behavior.

Default policy:

```text
soft_pressure = max(estimated_input, last_provider_reported_input)
                 >= context_window - output_reserve - tool_reserve - safety_margin

recovery order:
  1. evict expired/rebuildable tool payloads to artifacts
  2. remove duplicate/stale file reads
  3. trim paired historical tool calls/results
  4. retrieve narrower symbol/file ranges
  5. propose/apply bounded prune
  6. compact an eligible old history range
  7. if still impossible -> CONTEXT_BUDGET_EXCEEDED with exact diagnostics
```

A provider's reported input-token usage, when available, is recorded and may raise pressure earlier than estimates. Estimates never overwrite measured usage.

Protect:
- active Goal/acceptance criteria and latest approved decisions;
- unresolved approvals/questions;
- current user request;
- recent conversational intent needed for coherence;
- current Task/Attempt state;
- source refs necessary to interpret the pending diff/tool call.

The exact number of protected recent turns is model/profile policy, not a universal constant.

## 30.5 Prompt compiler for small/local models

A small model must not receive the same control prompt as a large hosted model.

Provider request is layered:

```text
Layer 0 — compact immutable protocol/safety contract
Layer 1 — selected agent identity + current objective
Layer 2 — tiny repository/environment facts
Layer 3 — only currently exposed tools
Layer 4 — retrieved source/context
Layer 5 — current conversation slice
Layer 6 — output/tool result protocol
```

### Bootstrap target

The compiler has an explicit `maxCompiledControlTokens` per profile. For small-context models, start with the smallest safe control contract and expand only on demand. The runtime measures the actual tokenizer where available; it does not assume a fixed chars/token ratio.

No full tool catalog, full skill descriptions, full repository map or full HorizonCode documentation is included by default.

### Progressive tool exposure

Expose a minimal starter surface such as:

```text
context.search
tools.search
repo.overview
symbols.search
files.read
files.patch (only in edit mode)
terminal.run (only when permitted)
task.finish/propose
```

`tools.search(query)` returns compact tool descriptors. The model may request a tool family; the next provider turn pins the expanded toolset generation.

For models without native function calling:
- use an explicit selected harness with a small structured envelope;
- parse/validate strictly;
- allow a bounded repair attempt for malformed structure;
- never execute ambiguous text as a privileged command.

### Harness selection is independent from model/provider

The selected `HarnessProfileV1` controls request **shaping**, not routing. It may define:
- system/control prompt structure;
- initial and discoverable tool projection;
- message lowering/role conversion;
- structured/text action decoding;
- output shaping and context policy.

The same Ollama/LM Studio/LiteLLM/OpenAI-compatible model may be tested with
`native-rich`, `native-minimal`, `bash-only` or an explicit compatibility harness while the
endpoint/provider/model identity remains byte-for-byte pinned in the run configuration.
An incompatible harness returns `UNAVAILABLE`; HorizonCode does not “fix” incompatibility by
choosing a different model.

The `bash-only` profile uses independent bounded subprocess actions by default so one command's
shell state does not implicitly contaminate the next action. Stateful PTY/terminal sessions remain
a separate explicit tool when the task actually requires them. All shell actions still become
ordinary ToolIntent/ToolBatch effects.

Harness measurements include prompt tokens/bytes, tool-schema tokens/bytes, context headroom,
parse/repair rate, TTFT and task outcome so a richer harness must justify its cost.

## 30.6 First-class local inference providers

V1 provider UX must explicitly support:

- **Ollama**
- **LM Studio**
- **LiteLLM**
- **arbitrary OpenAI-compatible endpoint**

These are provider configurations, not different product modes.

```ts
type LocalEndpointProfileV2 = {
  endpointId: string
  kind: "ollama" | "lm_studio" | "litellm" | "openai_compatible"
  baseUrl: string
  authSecretRef?: string
  modelId: string
  protocol: "chat_completions" | "responses" | "custom"
  contextWindow?: number
  maxOutputTokens?: number
  requestByteLimit?: number
  capabilities: {
    streaming: "yes" | "no" | "unknown"
    nativeTools: "yes" | "no" | "unknown"
    structuredOutput: "yes" | "no" | "unknown"
    images: "yes" | "no" | "unknown"
    promptCaching: "yes" | "no" | "unknown"
  }
}
```

A capability probe is read-only and bounded. Unknown values remain unknown. The user sees detected versus configured capability separately.

### Local model guarantees

- No network to a paid provider unless the user selected/authorized it.
- Offline mode also disables web/MCP/embedding/network services unless explicitly permitted.
- If a chosen local model cannot complete the requested workflow, report the missing capability and possible harness options without silently selecting another model.
- Hardware insufficiency yields diagnostics (RAM/VRAM/context/request size), not automatic cloud fallback.
- The product must remain useful with small context by retrieval, narrow tools and short prompts.

## 30.7 Repository intelligence architecture

`RepoIntelService` owns derived, rebuildable repository intelligence. Workspace/Git remains canonical.

Pipeline:

```text
manifest discovery
  -> language/framework/build/test detection
  -> file inventory
  -> parser/tree-sitter symbols
  -> persistent lexical/symbol index
  -> LSP enrichment on demand
  -> optional semantic embeddings only when explicitly enabled
```

Do not start an embedding model merely to open a project.

## 30.8 SymbolIndexV2

```ts
type SymbolKindV2 =
  | "class" | "interface" | "enum" | "function" | "method"
  | "type" | "variable" | "property" | "module" | "trait"
  | "struct" | "constant"

type SymbolRecordV2 = {
  symbolId: Id<"SymbolId">
  repoGeneration: RepoGenerationId
  path: string
  language: string
  kind: SymbolKindV2
  name: string
  qualifiedName?: string
  startLine: number
  endLine: number
  signatureHash: Digest
  enclosingSymbolId?: string
  exported?: boolean
}

type ReferenceEdgeV2 = {
  fromSymbolId?: string
  fromPath: string
  fromLine: number
  toSymbolId?: string
  text: string
  confidence: "high" | "medium" | "low"
  source: "lsp" | "parser" | "import_graph" | "lexical"
}
```

Drift-safe lookup:
1. verify file/repo generation;
2. if stale, reparse target file;
3. match signature hash + local structural context;
4. return updated ID/range or explicit `SYMBOL_STALE`, never a silently wrong location.

## 30.9 Built-in repository-intelligence tools

| Tool | Purpose | Model-visible output |
|---|---|---|
| `repo.detect` | languages/framework/build/test/package systems | compact structured manifest |
| `repo.tree` | bounded directory tree | filtered paths only |
| `symbols.search` | BM25/fuzzy symbol lookup | names/kinds/path/line/confidence |
| `symbols.outline` | symbol tree for one file | IDs + ranges |
| `symbols.read` | exact source for symbol ID | bounded source |
| `references.find` | callers/imports/type refs | confidence-tiered edges |
| `definitions.find` | definition resolution | exact or candidates |
| `impact.analyze` | likely dependents/tests/contracts | evidence-backed graph |
| `text.search` | fallback lexical/regex search | bounded matches |
| `diagnostics.get` | LSP/compiler/linter diagnostics | typed diagnostics |
| `tests.related` | map changed symbols/files to tests | ranked test targets |

BM25/fuzzy matching supports camelCase and snake_case normalization. Ranking is deterministic given one index generation.

Target language parsers for V1 should cover the product's highest-value languages first and expand through adapters. Desired broad catalog includes TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#, Kotlin, Swift, Ruby, PHP and Scala; unsupported languages fall back to lexical/LSP tools rather than pretending full symbol coverage.

## 30.10 Index lifecycle and performance

Index state:

```text
ABSENT -> BUILDING -> CURRENT -> STALE -> BUILDING
                    -> PARTIAL
                    -> FAILED
CURRENT/PARTIAL -> RETIRED
```

- initial index streams useful partial results; user does not wait for full repository indexing to chat;
- filesystem watcher batches/debounces changes;
- only changed files reparse when possible;
- index storage is embedded/rebuildable, not another external daemon dependency;
- 50K+ file repositories require bounded queues, ignored-directory rules and memory limits;
- index corruption triggers rebuild, never source changes;
- source read permissions are applied before indexing and querying.

## 30.11 Context caching

Cache metadata is provider-specific and advisory.

Context compiler marks stable segments:
- static control prompt;
- pinned profile/tool protocol;
- stable project rules;
- history prefix/compaction;
- attachments/files with immutable digest;
- current turn.

Analytics records whether the provider reported cache reads/writes/hits. HorizonCode never fabricates a cache-hit percentage from unsupported providers.

Changing one dynamic file should not invalidate unrelated static system/project segments when the provider protocol supports independent cache boundaries.

## 30.12 History search

History remains useful after `clear/trim/prune/compact`.

`history.search` searches authorized canonical session ranges and artifacts by lexical/FTS index first; optional model synthesis happens only after candidate retrieval. It returns message/artifact refs and can add selected entries back to context with user-visible provenance.

The built-in History Search specialist is read-only and receives only candidate ranges, not the entire account history.

## 30.13 Accuracy rules for small models

Small models benefit from **more deterministic harness, less prompt**, not hidden escalation.

- enforce one task objective at a time;
- prefer exact structured schemas with small enums;
- split compound tool batches when the selected harness/model cannot reliably produce them;
- validate file hashes before patches;
- use compiler/LSP/test feedback rather than asking the model to infer success;
- make repository tools return concise structured facts;
- cap repair attempts and change strategy after repeated identical failure;
- use specialist retrieval rather than copying repository summaries;
- final verification is external to the producing model.

## 30.14 LanguageServiceBroker and editor/LSP coexistence

HorizonCode must improve Pyright, rust-analyzer, TypeScript server, clangd, jdtls and other
language services rather than fight them.

`LanguageServiceBroker` owns discovery/routing, not language semantics:

```ts
type LanguageServiceSourceV1 =
  | { kind: "editor"; clientId: string; serverName: string }
  | { kind: "supervised"; executionId: string; serverName: string }
  | { kind: "external"; adapterId: string; serverName: string }

type LanguageServiceSnapshotV1 = {
  source: LanguageServiceSourceV1
  workspaceId: WorkspaceId
  languageId: string
  rootUri: string
  configurationDigest: Digest
  serverVersion?: string
  capabilitiesDigest: Digest
  health: "starting" | "healthy" | "degraded" | "failed"
  generation: number
}
```

Routing order is capability- and trust-based, not a universal preference:
1. reuse a compatible, healthy editor/project service through an authenticated adapter when
   attaching does not disturb the editor;
2. reuse HorizonCode's already-supervised service for the same root/config generation;
3. start one supervised service only when needed and permitted;
4. fall back to parser/symbol/lexical tools when no language server is usable.

Rules:
- do not launch a duplicate Pyright/rust-analyzer/tsserver merely for one query;
- do not kill/reconfigure an editor-owned server;
- workspace root/config/interpreter/toolchain differences create distinct generations;
- diagnostics from different sources retain source/version so contradictory results remain visible;
- LSP writes/commands/code-actions that mutate state are ordinary effects, not read-only queries;
- server stderr/output is bounded/artifactized;
- project-supplied server binaries/config are untrusted execution inputs and use ExecutionHost;
- optional LSP/MCP adapters normalize into the same definitions/references/diagnostics tools.

The local `indexd` implementation is currently only a bounded lexical slice; it must not be
reported as this complete service until persistence, parsing/symbols, watcher lifecycle and
LSP integration are actually wired and verified.

## 30.15 Context epoch markers and named reviewed memory blocks

Every `clear` creates a visible `ContextEpochMarker` with prior/new epoch IDs, triggering
action, timestamp and retained pinned references. UI/history search can cross the marker;
provider context compilation does not unless explicit retrieval reattaches old material.

Reviewed memory may expose named blocks such as:
- Project Setup
- Architecture Decisions
- Build/Test Commands
- User Preferences
- Known Constraints

The names are organization/UI conveniences over provenance-bearing MemoryRecords, not arbitrary
free-form prompt files. A block edit records source, revision and reviewer. Model-extracted
memory remains a candidate until accepted by MemoryService policy. Named blocks never override
Goal/spec/security/evidence.

## 30.16 Local-model transport timing and strict structured-call rules

Provider timing separates:
- DNS/connect/TLS or local socket reachability;
- server queue;
- model load/warm-up until response start;
- time-to-first-token;
- steady-state generation;
- tool/result round trips.

For local endpoints, `responseStartTimeoutMs` may be much larger than connect timeout because
loading multi-GB weights is not endpoint failure. Every wait remains cancelable and visible.
Cold start does not by itself open a provider circuit breaker. Repeated health/connect failures
do.

Malformed structured output fails closed:
- truncated JSON strings/objects are never repaired by inventing a terminator/value;
- duplicate/unknown required fields follow the pinned schema policy;
- deterministic whitespace/fence extraction may normalize representation only;
- optional model-assisted repair creates a *new* candidate message/tool call with its own ID;
- the repaired candidate is fully schema/policy validated and counts against a bounded repair
  budget;
- no command/file path/argument guessed by the harness is ever executed.

Compatibility gateways such as LiteLLM may stream non-contiguous tool-call indexes or
provider-specific deltas. The adapter may reorder/assemble only when identity/order is
unambiguous and tested; otherwise return a typed protocol error.

## 30.17 Terminal/log retrieval without context flooding

Long terminal/build/test streams are stored as bounded append-only managed artifacts. The
model gets short live tails and structured exit/diagnostic facts; terminal retrieval never
accepts a caller-supplied filesystem path or materializes a full log in model context.

Built-ins:
- `terminal.output_range(artifactID, generation, lineStart, lineEndExclusive, maxBytes)`;
- `terminal.search(artifactID, generation, query|regex, maxResults, maxBytesPerExcerpt)`;
- `artifacts.search_text(artifactRef, query|regex, maxResults)`.

`artifactID` is opaque and managed by the artifact owner; every retrieval supplies its
expected generation. Terminal line references are stable, zero-based, half-open ranges
`[lineStart,lineEndExclusive)` and search matches include generation-bound byte offsets.
Results are bounded excerpts plus line/range references and digest/generation metadata.
Rotation, truncation or replacement advances generation; stale references fail with
`STALE_GENERATION` rather than resolving to different content. `query|regex` preserves
the selected literal-query or regular-expression mode. Terminal search/output-range
accept no `processRef`, arbitrary path or full-log injection. PTY status/replay is a
separate bounded terminal-ID/generation operation, not artifact search.

## 30.18 Acceptance tests

- 4K/8K context fixture can inspect and patch a small repo without prompt overflow.
- Local OpenAI-compatible endpoint receives no unexpected network/provider fallback.
- Ollama/LM Studio/LiteLLM configs round-trip and keep exact selected model.
- Model with no native tools can use the explicitly chosen minimal harness or receives unsupported status.
- Tool search exposes only requested descriptors and changes the next toolset generation.
- `trim` removes payload bytes but history/artifact recovery works.
- `prune preview` cannot remove protected entries.
- `compact` preserves a protected constraint and source range.
- `clear` creates a visible epoch marker; history search can recover and explicitly reattach prior facts.
- actual provider token count can trigger recovery even when character estimate is low.
- symbol edit causes drift-safe re-resolution or explicit stale failure.
- 50K-file synthetic repo keeps indexing memory/latency within configured budget and remains interactive during build.
- permission-denied files never enter index/search/context.
- healthy editor-owned Pyright/rust-analyzer fixture is reused without spawning a duplicate server.
- differing interpreter/root/config causes a new language-service generation rather than cross-project result reuse.
- language-server code action cannot mutate state while Plan/read-only mode forbids mutation.
- cold local model may exceed normal cloud response-start timeout while remaining cancelable and healthy.
- truncated JSON tool call is rejected; no guessed argument reaches Guard/ExecutionHost.
- LiteLLM-style fragmented tool stream assembles only when identity/order is unambiguous.
- 100 MB terminal artifact can locate a target error by bounded search without adding the whole output to context.
- current `indexd` lexical-only implementation reports PARTIAL/unavailable symbol features until the full service is wired.

## 30.19 Cache adapter and schema traceability

The provider/cache telemetry adapter contract is §37.9. Actual model endpoint and harness remain pinned; provider-reported cache buckets are measured only when reported, estimates labeled and unknown never coerced to zero. Static/context digest design does not claim a cache hit. LanguageServiceSnapshotV1 schema and §37.4 govern LSP broker identity, generation and stale-result errors; an editor-owned server must not be killed or duplicated by a query tool. Implement adapter/runtime fixtures before VERIFIED status.
