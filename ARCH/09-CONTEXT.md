# 09 — Context Engine

Module-level design for `CMP-context` (Capability layer). This document owns
*what the model sees now*: assembly, budget, repo map, symbols, selection,
compaction, pins/excludes, and context sharding. It does not own the durable
event log (`CMP-session`), routing/window resolution (`CMP-provider`), policy
(`CMP-guard`), or sub-agent scheduling (`CMP-orch`).

## Purpose

Prove `REQ-CTX-001..005` and `DEC-006`. The context engine turns a durable,
event-sourced session plus a parsed repository into a bounded, deterministic,
reconstructable model request. Two properties are non-negotiable:

1. **The log is truth; the prompt is a projection.** Nothing the engine emits is
   authoritative, and nothing the engine drops is lost — the event log retains it.
2. **Budget honesty.** The engine estimates cost before every request and never
   discovers overflow from the provider (`REQ-CTX-004`).

## Responsibilities

Owns:

- assembly order and the stable-prefix / dynamic-suffix split;
- token estimation and the named budget model;
- typed system-context sources (baseline / update / reconcile, epoch pinning);
- instruction discovery (global config + project walk);
- the ranked repository map (repo map) under a token budget;
- symbol intelligence via LSP plus an index-exchange ingest;
- deterministic selection (embeddings are a deferred fallback, never the first path);
- the compaction engine and its trigger rule;
- eval-gated compaction quality;
- pin / exclude;
- snapshot / rebuild;
- sub-agent and worktree context sharding.

Never owns: the message history itself (`CMP-session`), model window resolution
and tokenizer selection (`CMP-provider`), permission decisions (`CMP-guard`),
or sub-agent lifecycle (`CMP-orch`).

## Interfaces

| Counterpart | Direction | Contract |
|---|---|---|
| `CMP-runner` | caller | `assemble(step) -> Request`; `estimateBudget(request)`; `compactIfNeeded(step)`; `compactAfterOverflow(step)` |
| `CMP-session` | read | ordered projected history + latest compaction marker + context epoch row |
| `CMP-provider` | read | resolved context window and output limit for the active route |
| `CMP-tools` | read | materialized tool definitions and their JSON schemas (counted, never owned) |
| `CMP-orch` | caller | `shard(parent, child task) -> ChildContextRequest` |
| `CMP-tui` | read | context-inspector fields (window / usable / current / per-source / pinned / excluded) |
| `CMP-guard` | callee | instruction and external content is injected as untrusted data |

The engine exposes one control entry (`assemble`) and two recovery entries
(`compactIfNeeded`, `compactAfterOverflow`). No surface calls the repo map,
LSP, or compaction internals directly.

## Data / state model

**`ContextItem`** — the unit of selection.

| Field | Meaning |
|---|---|
| `id` | stable reference into the owning source |
| `source` | `repo` · `file` · `tool` · `instruction` · `memory` · `checkpoint` · `session` |
| `type` | `repo_map` · `file_excerpt` · `tool_result` · `rules` · `symbol` · `diagnostic` |
| `content_ref` | a reference where possible, an inline copy only when unavoidable |
| `token_cost` | measured or estimated (see below) |
| `pinned` / `reconstructable` | pinned survives compaction to a ceiling; reconstructable may be dropped and rebuilt deterministically (non-reconstructable items are never pruned blindly) |
| `priority` / `freshness` / `scope` | deterministic ranking inputs; scope is `root` · `task` · `step` · `workspace` · `project` · `user` |

**`SystemContext.Source<A>`** — one independently refreshable typed system source:

```
Source<A> { key: Key(namespaced), codec: Codec<A, Json>, load: Effect<A | Unavailable>,
  baseline(current: A) -> string, update(previous: A, current: A) -> string,
  removed?(previous: A) -> string }
```

**`SourceSnapshot`** — `{ value: Json, removed?: NonEmptyString }`, the durable
comparison state for one admitted source. **`Snapshot`** is the record
`key -> SourceSnapshot` for one generation. **`Generation`** is
`{ baseline: string, snapshot: Snapshot }`.

**`ContextEpoch`** (persisted) — `{ baseline, snapshot, baseline_seq }`. It pins
the admitted baseline and the log position it belongs to. History projection
excludes system rows at or below `baseline_seq`, so a baseline is rendered once
and only deltas advance.

**`Checkpoint`** — the compaction artifact: `{ summary, recent, shadowed_range,
shadowed_seqs, shadowed_token_count, trigger, model }`. The event log is never
rewritten; the checkpoint is a projection boundary.

## Lifecycle & flows

### 1. Assembly order

Requests are assembled in a fixed order so the prefix stays cache-stable
(`REQ-CTX-005`, stable-prefix discipline):

`system sources` (typed, ordered, frozen for the generation: env, date,
instructions, mode) → `tool definitions` (materialized by `CMP-tools`, counted)
→ `history` (projected messages, oldest → newest, with tool results interleaved
at their position) → `dynamic suffix` (current task, retrieved items, new
observations).

System sources render through one `combine` with duplicate-key rejection; each
source contributes its baselines in declared order. The output is the model
request plus a `Snapshot` for the next reconcile.

### 2. Baseline, update, reconcile

- **initialize** — observe every source concurrently; all must be `Available`,
  otherwise initialization is *blocked* with the missing keys named. A missing
  source is never silently treated as removed.
- **reconcile** — compare current values to the snapshot. Each source yields
  `Unchanged` or `Updated(render)`; a decode mismatch, or a vanished key without
  a removal renderer, forces a full **replace**. Reconcile returns `Unchanged`,
  `Updated { text, snapshot }`, or `ReplacementReady`.
- **replace** — a complete new generation. Blocked while any previously admitted
  source is currently `Unavailable`; replacement waits rather than constructing
  an incomplete baseline.
- **epoch pinning** — the epoch row records `baseline_seq`. A compaction whose
  sequence is newer than `baseline_seq` triggers a replacement generation. If
  `baseline_seq` also moved (external reset), the selection is reset too.

`Unavailable` is a first-class outcome: it preserves the admitted snapshot and
retries, and never degrades into an unplanned context.

### 3. Token estimation and budget model

Estimation is deterministic and cheap: `estimate(text) = round(len(text) / 4)`,
clamped at 0, applied to `JSON.stringify` of a structured value where needed.
When the provider reports usage, the measured value replaces the estimate for
budget accounting; the estimate is the pre-send gate.

Named budget terms (no magic numbers in code):

`usable = window − max(output, buffer)` (the pre-send gate),
`keep_recent = keep.tokens` (serialized tail retained intact), and
`summary_output = min(requested_output, summary_token_cap)` (summarize-call cap).

Defaults: `buffer = 20_000`, `keep.tokens = 8_000`,
`summary_token_cap = 4_096`, `tool_output_chars = 2_000` during serialization.
Window and output come from `CMP-provider`'s resolved route; the engine never
hardcodes a window.

### 4. Compaction engine

Trigger rule (exact, `REQ-CTX-002`):

```
if estimate(system + messages + tools) <= window − max(output, buffer): no compaction
else:                                                                  compact
```

`compactIfNeeded` runs pre-send, before the model call. `compactAfterOverflow`
handles a provider-confirmed overflow and retries the same step once
(`REQ-CTX-004`).

The compaction sequence:

1. **Select** — serialize entries (excluding prior compaction markers), walk
   newest → oldest accumulating estimated tokens until `keep.tokens` is reached;
   the split yields `head` (to summarize) and `recent` (retained verbatim).
2. **Serialize with truncation** — each entry becomes a role-tagged line
   (`[User]`, `[Assistant]`, `[Assistant tool call]`, `[Tool result]`,
   `[Shell]`), and tool content longer than `tool_output_chars` is truncated with
   an explicit `[truncated]` marker.
3. **Summarize** — a single model call with tools disabled and
   `maxTokens = summary_output`. The prompt contains the conversation head,
   plus the prior summary when one exists, plus update instructions.
4. **Land** — append a checkpoint carrying `summary`, `recent`, the shadowed
   range, and the count. The checkpoint renders as historical context framed as
   untrusted, non-instructional background.
5. **Tool pairing** — a compaction boundary never splits an assistant tool call
   from its result; both edges of the selected span must be balanced, else the
   span is rejected and a safe adjacent range chosen.

**Anchored summary template** — our own structure, implemented by us, not
transcribed from any upstream template (see `ARCH/05` §2). Section order is fixed;
empty sections render `(none)`; entries stay terse (bullets, not paragraphs); exact
paths, symbols, commands, and error strings are copied verbatim, never reworded:

`## Aim` → `## Load-Bearing Facts` → `## Where Things Stand` (`### Settled` /
`### In Flight` / `### Held Up`) → `## Next Concrete Action` → `## Touchpoints`.

Each section answers exactly one question: what we are trying to achieve (*Aim*);
the constraints, decisions, versions, and exact errors that must survive
(*Load-Bearing Facts*); what is finished, underway, and blocked (*Where Things
Stand*); the single next action (*Next Concrete Action*); and the files/symbols in
play (*Touchpoints*).

When a prior summary exists, the new summary must carry forward the aim,
constraints, decisions, and parallel workstreams; the conversation wins on conflict;
finished items move from In Flight to Settled; resolved blockers are updated.

`auto: false` disables automatic compaction but never disables manual compaction.

### 5. Eval-gated compaction

Window fit is necessary, not sufficient (`REQ-CTX-003`). A retrieval evaluation
scores whether facts required to continue survive a compaction: a fixed probe
set of "must remain retrievable" facts (paths, identifiers, pending tasks,
blockers) is checked against the post-compaction context (summary + tail). A
strategy or template change is adopted only if it does not regress the probe
score; regressions are recorded with the evaluation id. The gate runs offline
against captured sessions, not on the live critical path.

### 6. Instruction discovery

`REQ-CTX-005`:

1. Read the **global** config instruction file (`<config>/AGENTS.md`).
2. Walk **up** from the working directory to the project root, collecting each
   `AGENTS.md` along the way; stop at the project root, never above it.
3. Deduplicate by absolute path, global first, then nearest → outermost.
4. Render each as `Instructions from: <absolute path>\n<content>`, joined by a
   blank line, as one typed `core/instructions` source.

If a *discovered project* file cannot be read, the source reports `Unavailable`
and initialization is blocked (fail closed). A missing global file is simply
absent. When instructions change, the update line states that the new set
*replaces* all previously loaded ambient instructions, and removal states that
the prior instructions no longer apply — the renderer never appends a partial
diff.

### 7. Repo map

`REQ-CTX-001`. Build is incremental and never blocks the loop (`REQ-PERF-003`).

```
git-tracked files
  → ignore rules (build/vendor/vendor dirs, size caps)
  → tree-sitter tags per file: definitions + references
  → file graph: edge A→B when A references a symbol defined in B
  → PageRank over the graph (damping, session personalization)
  → rank files; within a file rank symbols by incoming references + centrality
  → render signatures (never bodies) top-down until the token budget is spent
```

- **Ranking:** PageRank with a damping factor, personalized by the task's
  mentioned/opened files so an active area outranks a globally central one.
  Deterministic given `(graph, budget, personalization)`.
- **Rendering:** signatures and key references only, stable ordering, cache-
  friendly, to protect the stable prefix.
- **Budget:** the repo map receives a declared token allowance from the budget
  model. Zero budget ⇒ zero map (`REQ-CTX-001`).
- **Dynamic expansion:** when the agent opens or names a file, that file's
  subtree expands on demand as a separate `file_excerpt` item; the coarse map is
  not re-sent.
- **Incremental:** re-parse only files whose content hash changed; stale edges
  are flagged and queries prefer fresh subgraphs.
- **Provenance:** heuristic graph edges (tree-sitter level) are labeled as
  inferred and never presented as certain; compiler/LSP-grade edges are labeled
  distinctly.

### 8. Symbol intelligence

- **LSP bridge:** definitions, references, hover, diagnostics, document/workspace
  symbols; rename is policy-gated. Absent or crashed servers degrade to the
  tree-sitter graph + lexical search — never a silent empty answer.
- **Index-exchange format:** a language-neutral artifact of
  `{ symbol, kind, file:range, references[] }` records produced by an external
  indexer is ingested into the per-workspace store to supply precise,
  compiler-grade edges where a live server or compile step is unavailable.
- Diagnostics are a typed context item and may be injected under budget.

### 9. Selection before embeddings

Selection is deterministic first: relevance, scope match, pins, recency, and
graph centrality. Inferred embeddings/reranking are explicitly deferred until a
measured recall miss on paraphrase queries justifies them; the interface leaves
room but the default path never embeds. This keeps selection auditable and the
prompt stable.

### 10. Pin, exclude, snapshot, rebuild

- **Pin** — marks an item to survive selection and compaction up to a ceiling;
  pinned items consume budget and are visible in the inspector.
- **Exclude** — marks an item or path to never enter an assembly, regardless of
  ranking. Exclusions are evaluated before ranking so they cost nothing.
- **Snapshot** — the generation baseline + `Snapshot` is durable; a resumed
  session reconciles against it rather than re-deriving.
- **Rebuild** — recompute the generation from live state. `rebuild` prefers live
  state over a stale baseline or checkpoint; memories/checkpoints are hints, not
  authority.

### 11. Sub-agent and worktree sharding

`REQ-ORCH-001/002/005`. Each child assembles its own context; the parent passes
a bounded snapshot (the task plus explicitly inherited refs), never its
transcript. Project rules are delivered to children. Worktree-isolated children
receive their own repository root and therefore their own repo map and index
scope. Children return receipts; only receipts enter the parent's context.
Depth and count are bounded by configuration (`CMP-orch` enforces the bound;
the engine only shards).

## Failure modes

| Failure | Behavior |
|---|---|
| Tokenizer/estimate drift | Conservative defaults; re-measure on model switch; the pre-send gate uses the resolved window. |
| Provider context overflow | `compactAfterOverflow` once, then retry the step; bounded, never an infinite loop; if still over, the step fails closed with guidance. |
| Source `Unavailable` | Preserve the admitted snapshot; block initialization/replacement rather than render an incomplete baseline. |
| Duplicate source key | Rejected immediately at `combine`. |
| Snapshot decode mismatch | Force a full replacement generation; never partially trust a corrupt snapshot. |
| Prune removes a needed item | `reconstructable` guards blind pruning; non-reconstructable items are retained or summarized, never dropped silently. |
| Compaction span splits a tool pair | Span rejected; choose a balanced adjacent range. |
| Summarize call fails/truncates | Compaction returns "not compacted"; the turn proceeds on the existing context or fails closed on true overflow. A summary that is empty or image-only is rejected. |
| Repo map/LSP unavailable | Degrade to tree-sitter + lexical search; mark diagnostics unavailable. |
| Stale checkpoint | Rebuild prefers live state; checkpoints are versioned. |

## Configuration

| Key | Meaning | Default |
|---|---|---|
| `compaction.auto` | enable automatic compaction | `true` |
| `compaction.buffer` | reserve subtracted from the window | `20000` |
| `compaction.keep.tokens` | serialized tail retained verbatim | `8000` |
| `compaction.summary.max_tokens` | summarize-call cap | `4096` |
| `tool_output.max_lines` | model-visible tool-output line bound | `2000` |
| `tool_output.max_bytes` | model-visible tool-output byte bound | `51200` |
| `repo_map.budget_tokens` | repo-map allowance | design default (see open questions) |
| `context.eval_gate` | enable the retrieval-eval gate | `true` |

Config discovery is global → project, nearest wins; values are per-model-class
overridable. No key changes an authorization decision (`CMP-guard` owns that).

## Requirements mapping

| Requirement | Where satisfied |
|---|---|
| `REQ-CTX-001` | Ranked repo map from tracked files + language parsing (§7). |
| `REQ-CTX-002` | Trigger rule, serialized tail + structured summary (§3, §4). |
| `REQ-CTX-003` | Eval-gated compaction, not window-fit only (§5). |
| `REQ-CTX-004` | Pre-send estimate + overflow compaction-and-retry (§3, §4). |
| `REQ-CTX-005` | Hierarchical `AGENTS.md` discovery as a typed source (§6). |
| `REQ-PERF-003` | Incremental indexing off the loop (§7). |
| `REQ-ORCH-001/002/005` | Sharded child context + receipts (§11). |
| `REQ-HORIZON-002` | Task graph survives compaction (checkpoint carries work state). |
| `REQ-SEC-002` | Instructions/retrieved content framed as untrusted data. |

## Open questions

1. **Default `buffer`/`keep`/`summary-cap` per model class.** Absolute floors vs
   percentage-of-window for small local models. (→ `DEC-006` tuning.)
2. **Repo-map budget default and personalization policy.** The token allowance
   and how strongly an active file overrides global centrality are unmeasured.
3. **Tokenizer strategy.** A single conservative estimator vs per-provider
   tokenizers; the drift threshold that forces re-measurement is unspecified.
4. **Index-exchange ingest scope.** Which indexer artifact is consumed, and
   whether it is required or purely an accelerator.
5. **Eval probe set ownership and thresholds.** Who curates the "must survive"
   facts and what regression margin blocks a strategy change.
6. **Embedding/rerank trigger.** The concrete recall metric and threshold that
   would move selection away from its deterministic-first design.
