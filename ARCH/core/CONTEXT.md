# Context Engine

Module-level design for `CMP-context` (Capability layer). This document owns
*what the model sees now*: assembly, budget, selected repo-map projections, selection,
compaction, pins/excludes, and context sharding. It does not own the durable
event log (`CMP-session`), routing/window resolution (`CMP-provider`), policy
(`CMP-guard`), or sub-agent scheduling (`CMP-orch`).

## Purpose

Prove `REQ-CTX-001..005` and `DEC-006`. The context engine turns a durable,
event-sourced session plus a parsed repository into a bounded, deterministic,
reconstructable model request. Two properties are non-negotiable:

1. **The log is truth; the prompt is a projection.** Context is a derived projection. Canonical source owners retain source records under their explicit retention policies; selection never deletes those records.
2. **Budget honesty.** The engine proactively estimates cost before every request to
   avoid predictable overflow (`REQ-CTX-004`). Estimation cannot guarantee provider
   acceptance: if a provider still reports overflow before streamed content begins,
   with auto compaction enabled the runner permits exactly one bounded compact-and-retry of the same step; with auto=false it pauses/refuses typed. A
   second overflow becomes a typed failure. No mid-stream retry is allowed.

## Responsibilities

Owns:

- assembly order and the stable-prefix / dynamic-suffix split;
- token estimation and the named budget model;
- typed system-context sources (baseline / update / reconcile, epoch pinning);
- ordered assembly and rendering of typed instruction sources discovered and
  validated by `CMP-config` (`ARCH/core/CONFIG.md`); this component does not discover files;
- the ranked repository map (repo map) under a token budget;
- consumption of revision-bound symbol/LSP/index results from CMP-repo-intel (ARCH/product/CODE-INTELLIGENCE.md);
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
| `CMP-config` | read | ordered, validated instruction records with provenance and availability state (`ARCH/core/CONFIG.md`) |
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

**`ContextEpoch`** (persisted, versioned target) — `{ epoch_id, baseline, snapshot, baseline_seq, brief_digest, policy_digest, route_digest, tool_snapshot_digest, source_heads[], packet_ref, generation }`. It pins
the admitted baseline and the log position it belongs to. History projection
excludes system rows at or below `baseline_seq`, so a baseline is rendered once
and only deltas advance.

The context source's `update(previous,current)` is an internal projection delta, not
permission to append a new system message to every provider history. The adapter uses
complete effective-prompt replacement by default. A route may use an in-history
system-prompt update only when its pinned model capability proves that a later system
message replaces the effective prompt (rather than accumulating, being ignored, or
being rejected) and request fixtures verify that exact semantics. Unknown routes
replace; changing this mode changes the context epoch and route snapshot. This
optimization is separate from cache-hit support and is never inferred from generic
protocol compatibility.

**`Checkpoint`** — the compaction artifact: `{ summary, recent, shadowed_range,
shadowed_seqs, shadowed_token_count, trigger, model }`. The event log is never
rewritten; the checkpoint is a projection boundary.

## Lifecycle & flows

### Assembly order

Requests are assembled in a fixed order so the prefix stays cache-stable
(`REQ-CTX-005`, stable-prefix discipline):

Stable instructions and tool contracts use fixed deterministic ordering within the serialized prefix. Semi-stable selected skills/catalog/repository projections follow under pinned source digests. Volatile nonsecret runtime metadata, date, task state and retrieved observations are placed late. History preserves message/tool pairing and chronological order. Exact wire layout and cache boundaries follow the route adapter; no generic ordering overrides required protocol semantics.

The tool-definition term contains only the currently selected and permitted tools.
For large MCP/plugin catalogs, discovery metadata stays in a searchable catalog;
full schemas load on demand under a token allowance before a model step. The selected
names, schema digests, policy snapshot and catalog generation are pinned for that
step. A later catalog update starts a new context epoch; it cannot change the
meaning of a tool call already emitted. If the model names a tool absent from that
step's selection, return a typed unavailable-tool result and replan without
executing a similarly named replacement (`REQ-CTX-010`, `DEC-032`).

System sources render through one `combine` with duplicate-key rejection; each
source contributes its baselines in declared order. The output is the model
request plus a `Snapshot` for the next reconcile.

### Baseline, update, reconcile

- **initialize** — observe sources concurrently; mandatory policy/instruction sources must be `Available` before dispatch. Optional discovery/index sources may stay loading/unavailable and are omitted with explicit status until the next safe epoch. A previously admitted required source is never silently treated as removed.
- **reconcile** — compare current values to the snapshot. Each source yields
  `Unchanged` or `Updated(render)`; a decode mismatch, or a vanished key without
  a removal renderer, forces a full **replace**. Reconcile returns `Unchanged`,
  `Updated { text, snapshot }`, or `ReplacementReady`.
- **replace** — a complete new generation. Blocked while a mandatory policy/instruction source is unavailable; optional intelligence/catalog sources may be omitted with explicit status. Previously admitted required sources never silently vanish.
- **epoch pinning** — the epoch row records `baseline_seq`. A compaction whose
  sequence is newer than `baseline_seq` triggers a replacement generation. If
  `baseline_seq` also moved (external reset), the selection is reset too.

`Unavailable` is a first-class outcome: required source failures preserve evidence and block dispatch; optional source omissions are visible and bounded refresh happens outside the critical path.

### Token estimation and budget model

A provisional preflight estimate is deterministic and cheap: `estimate(text) =
round(len(text) / 4)`, clamped at 0, applied to `JSON.stringify` of a structured
value where needed. This is a rough byte heuristic, **not a conservative upper
bound or a tokenizer**; it can undercount multilingual text, unusual scripts,
code, and provider-specific serialization. Treat it as a provisional estimate
only. The pre-send gate must include an explicit uncertainty reserve derived from
route-specific calibration or a documented fail-closed bound; if request
serialization or estimation uncertainty cannot be bounded for a required budget,
refuse dispatch as `ROUTE_UNSATISFIABLE`. Reconcile actual provider usage when
reported without rewriting the estimate or claiming the estimate proved fit.

Named budget terms (no magic numbers in code):

`reserve = max(output, buffer) + estimation_uncertainty` and
`usable = window.saturating_sub(reserve)` (the pre-send gate). If `reserve >= window`,
return typed `ROUTE_UNSATISFIABLE` before provider dispatch; do not underflow or send a
zero-context request as valid. `estimation_uncertainty` is route/serializer-specific;
it must be calibrated from recorded request-versus-usage observations or set to a
documented fail-closed bound, and cannot be silently zero when calibration is absent.
`keep_recent = keep.tokens` (serialized tail retained intact), and
`summary_output = min(requested_output, summary_token_cap)` (summarize-call cap).

Defaults: `auto_threshold = 0.5` (50% of the resolved context window),
`buffer = 20_000`, `keep.tokens = 8_000`, `summary_token_cap = 4_096`, and
`tool_output_chars = 2_000` during serialization. The automatic threshold is a
fraction in `(0, 1]`, evaluated against the active route's resolved model window;
it is not a token count and is not derived from a universal model limit. Window and
output come from `CMP-provider`'s resolved route; the engine never hardcodes a
window.

### Compaction engine

Automatic trigger rule (exact, `REQ-CTX-002`):

```
utilization = estimate(system + messages + tools) / resolved_context_window
if compaction.auto && utilization >= compaction.auto_threshold: compact
else:                                                            do not auto-compact
```

The default threshold is `0.5`. `compactIfNeeded` evaluates it pre-send, before the
model call. This early trigger is independent of the hard admission limit:
`usable = window.saturating_sub(reserve)` (with `reserve` defined in the budget model). The hard
fit check always runs. If the assembled request exceeds `usable` and
`compaction.auto=false`, do not dispatch and return typed `CONTEXT_TOO_LARGE` with
manual-compaction and larger-context-route guidance. If auto is enabled, admit at
most one bounded compaction/rebuild attempt for that logical step; after rebuilding,
the hard fit check runs again and returns `CONTEXT_TOO_LARGE` if the request still
does not fit. Explicit manual compaction remains available when auto is disabled.

Automatic recovery has two distinct post-trigger classes: (a) a typed provider
context-window rejection before any response content/effect, owned by `REQ-CTX-004`;
(b) a typed response truncation proven by route conformance to use the remaining
context as its output cap, owned by `REQ-CTX-011`. Both require `compaction.auto=true`,
unchanged pinned route and user/control/task/workspace/spec/policy revisions, no
possible tool or provider-side effect, and a reservation for compaction, one retry,
and required verification. The controller persists one shared automatic
compaction/retry counter per logical step across both classes; whichever class spends
it first prevents a second recovery trigger on the same logical step. When auto is disabled, either error is surfaced without automatic
compaction/retry. Unknown, explicit output-cap, or second-failure outcomes are
terminal for automatic recovery. A new user instruction or approved replan creates a
new logical step/revision; it does not reset counters on an existing step.

The compaction sequence:

1. **Select** — serialize entries (excluding prior compaction markers), walk
   newest → oldest accumulating estimated tokens until `keep.tokens` is reached;
   the split yields `head` (to summarize) and `recent` (retained verbatim).
2. **Serialize with bounded observations** — each entry becomes a role-tagged line
   (`[User]`, `[Assistant]`, `[Assistant tool call]`, `[Tool result]`,
   `[Shell]`). An old completed tool result may be cleared from this *model-context
   projection* only after the exact full bytes are committed to `CMP-artifact`,
   digest-verified, and pinned by the canonical owner event. The projection then
   carries a bounded exact preview plus the immutable artifact reference/digest and
   retrieval instructions. This never edits the canonical Thread event or deletes
   artifact bytes. Uncommitted, open, unresolved, verifier-pinned, or otherwise
   required evidence is not cleared. If the artifact is absent, expired, or cannot
   be read, emit a typed unavailable result; never present an empty or summarized
   substitute as the original output (`REQ-CTX-006`, `ARCH/core/TOOLS.md`, `ARCH/product/ARTIFACTS.md`).
3. **Summarize** — first verify that the bounded summary input plus output allowance
   fits the selected compaction model's resolved window. If it does not, return a
   visible typed `COMPACTION_CONTEXT_TOO_LARGE` result; do not silently skip, switch
   models/routes, or dispatch the original over-budget request. If it fits, make a
   single model call with tools disabled and `maxTokens = summary_output`. The prompt
   contains the conversation head,
   plus the prior summary when one exists, plus update instructions.
4. **Land** — append a checkpoint carrying `summary`, `recent`, the shadowed
   range, and the count. The checkpoint renders as historical context framed as
   untrusted, non-instructional background.
5. **Tool pairing** — a compaction boundary never splits an assistant tool call
   from its result; both edges of the selected span must be balanced, else the
   span is rejected and a safe adjacent range chosen.

**Anchored summary template.** Section order is fixed;
empty sections render `(none)`; entries stay terse (bullets, not paragraphs); exact
paths, symbols, identifiers, commands, and error strings are copied verbatim, never
reworded. Code and tool observations may be retained only by verbatim selection or
grouping; they must not be abstracted, paraphrased, or converted into inferred intent
or state. Abstraction is permitted only for prose and must preserve uncertainty and
source attribution. Omitted code/tool observations must retain an exact recovery
reference:

`## Aim` → `## Load-Bearing Facts` → `## Where Things Stand` (`### Settled` /
`### In Flight` / `### Held Up`) → `## Next Concrete Action` → `## Touchpoints`.

Each section answers exactly one question: what we are trying to achieve (*Aim*);
the constraints, decisions, versions, and exact errors that must survive
(*Load-Bearing Facts*); what is finished, underway, and blocked (*Where Things
Stand*); the single next action (*Next Concrete Action*); and the files/symbols in
play (*Touchpoints*).

When a prior summary exists, the new summary must carry forward the aim,
constraints, decisions, and parallel workstreams; latest explicit user intent and current canonical source records resolve conflicts;
finished items move from In Flight to Settled; resolved blockers are updated.

`auto: false` disables automatic compaction but never disables manual compaction.

### Eval-gated compaction

Window fit is necessary, not sufficient (`REQ-CTX-003`). A retrieval evaluation
scores whether facts required to continue survive a compaction: a fixed probe
set of "must remain retrievable" facts (paths, identifiers, pending tasks,
blockers) is checked against the post-compaction context (summary + tail). A
strategy or template change is adopted only if it does not regress the probe
score; regressions are recorded with the evaluation id. The gate runs offline
against captured sessions, not on the live critical path.

### Instruction source assembly

`CMP-config` discovers and validates instruction files as specified by
`ARCH/core/CONFIG.md`, including the project-root boundary, path/content deduplication, and
scope precedence. It supplies an ordered list of typed instruction records to
`CMP-context`. Context owns rendering that list as one system source and its
baseline/update/replacement semantics under `REQ-CTX-005`:

1. Preserve the supplied order: global first, then outermost → nearest. A nearer
   instruction may override only conflicting advice within the lower-trust
   project-instruction scope; it never changes system policy or grants authority
   (`ARCH/core/CONFIG.md`, `DEC-031`).
2. Render each as `Instructions from: <absolute path>\n<content>`, joined by a
   blank line, as one typed `core/instructions` source.

If a discovered project file cannot be read, `CMP-config` reports `Unavailable`
and initialization is blocked (fail closed); a missing global file is absent.
When instructions change, the update line states that the new set
*replaces* all previously loaded ambient instructions, and removal states that
the prior instructions no longer apply — the renderer never appends a partial
diff.

### Repo map

`REQ-CTX-001`. CMP-repo-intel owns parsing, graphs, LSP/SCIP and index freshness. CMP-context selects/renders those results; incremental indexing runs outside the loop (`REQ-PERF-003`).

```
repository files in the selected source view (tracked by default; dirty, untracked,
and unsaved-buffer views are explicit, revision-bound inputs)
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

The Explorer project-path scanner consumes the same CMP-repo-intel source owner. It performs bounded asynchronous lookup,
coalesces/cancels superseded queries, binds results to the active workspace root and
query generation, and refuses to publish results after either changes. Truncated,
stale, cancelled, or unavailable scans are distinguishable from an empty result.

### Symbol intelligence

- **LSP bridge:** one `CMP-repo-intel` owner exposes read-only definitions,
  references, hover, diagnostics, document/workspace symbols, implementation
  lookup, and call-hierarchy preparation/incoming/outgoing calls. Each result
  carries the repository revision and source-file digest/freshness that were
  actually observed. Rename is a separate policy-gated write operation. Absent,
  unsupported, stale, or crashed servers return an explicit typed state and degrade
  to the tree-sitter graph plus lexical search — never a silent empty answer.
- **Shared ownership:** repository-intelligence tools call this same owner and its
  LSP client; they do not create another server manager, symbol index, or cache.
  External workspaces and files continue through the existing Guard/path boundary.
- **Index-exchange format:** a language-neutral artifact of
  `{ symbol, kind, file:range, references[] }` records produced by an external
  indexer is ingested into the per-workspace store to supply precise,
  compiler-grade edges where a live server or compile step is unavailable.
- Diagnostics are a typed context item and may be injected under budget.

### Repository task projections

`RepoBriefV1` is a bounded repository overview and `TaskPackageV1` is its task-specific
selection (`REQ-REPO-008`). Both are rebuildable projections of the single
repository-intelligence owner. `CMP-context` performs ranking, budget selection and
serialization; neither record creates a second index or canonical task store.

```text
RepoBriefV1 {
  schema_version: 1, brief_id, project_id, workspace_revision,
  index_binding: WorkspaceIndexBindingV1,
  policy_digest, source_methods[], overview_refs[], coverage,
  freshness, limitations[], omitted_context[], projection_digest
}
TaskPackageV1 {
  schema_version: 1, package_id, task_contract_ref, spec_digest?,
  repo_brief_ref, workspace_revision, index_binding, policy_digest,
  likely_files[], likely_symbols[], useful_ranges[], relevant_test_refs[],
  dependency_neighborhood[], diagnostic_refs[], recent_change_refs[],
  retrieval_handles[], byte_budget, token_budget, omitted_context[],
  freshness, coverage, limitations[], projection_digest
}
```

`WorkspaceIndexBindingV1` is defined once by [Workspaces](../execution/WORKSPACES.md).
Its absent generations represent no-index/direct or lexical fallback; they never
fabricate a READY generation. `ContextPacketV1.task_package_ref` pins the package
identity/digest, while selected package payload is serialized as ordinary ContextItems.
The full index or a second packet is never embedded.

Each selected entry retains exact source revision/range/digest and method; inferred
test relationships and syntactic edges remain advisory. The task contract may be a
direct-turn intent reference; a direct turn never fabricates a managed Task. The
projection is pinned to a `ContextEpoch`, linked by `task_package_ref` in the
existing `ContextPacketV1`, and selected into its ordinary ContextItems. It does not replace that packet's instructions, authority,
task contract, memory scope or budget.

Before a model step, deterministic prefetch may prepare a bounded overview, likely
files/symbols, diagnostics, changes and nearby tests from fresh available sources.
It cannot block interaction while an optional full index is loading. Unavailable or
stale sources produce explicit omissions and guarded raw search/read fallback.
Freshness validation and the ordinary pre-send fit gate still apply. The entire index
never enters model context. Detail grows progressively from overview/signatures to
exact ranges and task-relevant dependencies/tests through `repo_expand`.

A generation or policy change invalidates affected selections/handles and requires
refresh at a safe context epoch. Replaying an unchanged dispatch reuses the pinned
projection digest. Cached sharing between children does not imply provider cache
credit or free input usage. Acceptance is `ACC-REPO-TOOLS-01`.

### Selection before embeddings

Selection is deterministic first: relevance, scope match, pins, recency, and
graph centrality. Inferred embeddings/reranking are explicitly deferred until a
measured recall miss on paraphrase queries justifies them; the interface leaves
room but the default path never embeds. This keeps selection auditable and the
prompt stable.

### Pin, exclude, snapshot, rebuild

- **Pin** — marks an item to survive selection and compaction up to a ceiling;
  pinned items consume budget and are visible in the inspector. If required pins exceed
  the current route's usable budget, fail assembly with `PINNED_CONTEXT_OVER_BUDGET`
  listing the blocking references and measured estimates. Do not silently drop a pin or
  submit an incomplete request; the planner/operator must reduce scope, select another
  supported route, or explicitly revise the pin set.
- **Exclude** — removes optional data before ranking. Required policy, admitted task constraints and effect/recovery evidence cannot be excluded; attempts return a typed protected-source error. Required sources over budget block dispatch rather than disappearing.
- **Snapshot** — the generation baseline + `Snapshot` is durable; a resumed
  session reconciles against it rather than re-deriving.
- **Rebuild** — recompute the generation from live state. `rebuild` prefers live
  state over a stale baseline or checkpoint; memories/checkpoints are hints, not
  authority.

### Sub-agent and worktree sharding

`REQ-ORCH-001/002/005`, `REQ-MEM-005..007`. `CMP-context` builds a separately
budgeted, revision-bound `ContextPacketV1` for every child:

```text
ContextPacketV1 {
  packet_id: ContextPacketId,
  dispatch_id: DispatchId,
  packet_digest: Digest,
  thread_id: ThreadId,
  run_id?: RunId,
  task_id?: TaskId,
  attempt_id?: AttemptId,
  context_epoch_id: ContextEpochId,
  project_id: ProjectId,
  context_scope_digest: Digest,
  approved_task_contract_ref: ArtifactRef,
  spec_digest?: Digest,
  selected_source_refs: SourceRef[],
  instruction_refs: InstructionRef[],
  skill_refs: SkillRef[],
  memory_refs: MemoryRef[],
  permission_snapshot_digest: Digest,
  workspace_revision?: RevisionRef,
  task_package_ref?: TaskPackageRef,
  byte_budget: BoundedInt,
  token_budget: BoundedInt,
  omitted_context: OmissionRecord[],
  created_seq: OwnerSeq
}
```

It includes the approved
task/spec, selected source refs, effective instructions/skills, permission snapshot,
workspace revision, and explicit omissions. Parent and sibling transcripts and
auto-memory are excluded by default; `fork=none` is the default. A bounded fork
requires exact committed/user-visible references, byte/token limits, and effective
policy authorization. Full history is limited to explicit same-trust native dispatch;
an external adapter cannot receive it implicitly. Profile memory is off by default
and, when enabled, is independently retrieved from the existing memory store under
user/managed policy, Run consent, profile preference, adapter capability, and egress
scope. Eligible memory admission classes follow the memory owner contract. Advisory notes are labeled hints; changed source observations may serve only as revalidation leads until current sources support factual reliance. Record IDs, revisions, digests, capture generation and policy are pinned to the child `ContextEpoch`. Children return receipts; only
receipts enter the parent's context. Worktree-isolated children receive their own
repository root and repo-index scope. Depth and count are bounded by configuration
(`CMP-orch` enforces bounds; `CMP-context` only assembles the packet).

Each actual child dispatch records included/excluded source classes and observed input
usage independently. Fan-out input cost is charged per dispatch; a context artifact
shared by several workers is not counted as a single provider input unless the route
reports a cache hit. Unknown external usage stays unknown. Memory retrieval failure is
visible; it may be omitted only when the task permits that omission.

## Failure modes

| Failure | Behavior |
|---|---|
| Tokenizer/estimate drift | Conservative defaults; re-measure on model switch; the pre-send gate uses the resolved window. |
| Provider context rejection | If auto is enabled and the exact pre-content overflow class is proven, compact and retry once under the unchanged-revision/no-effect fence; otherwise return a typed terminal error. `auto=false` never triggers this recovery. |
| Remaining-context output truncation | If the pinned route proves this distinct finish cause, auto is enabled, and the no-effect/revision/budget fence passes, compact and retry once; explicit/unknown/second truncation is terminal. `auto=false` never triggers this recovery. |
| Hard pre-send fit failure | The hard fit guard always runs. `auto=false` returns `CONTEXT_TOO_LARGE` without dispatch; auto mode allows one compact/rebuild, then returns the same typed error if the request still does not fit. |
| Summary-model context too small | Automatic and manual compaction return typed `COMPACTION_CONTEXT_TOO_LARGE`; do not silently skip compaction, switch models/routes, or send an over-budget original request. |
| Source `Unavailable` | Required policy/instructions block dispatch; optional source omissions remain explicit and can refresh at the next safe epoch. |
| Duplicate source key | Rejected immediately at `combine`. |
| Snapshot decode mismatch | Force a full replacement generation; never partially trust a corrupt snapshot. |
| Prune removes a needed item | `reconstructable` guards blind pruning; non-reconstructable items are retained or summarized, never dropped silently. |
| Compaction span splits a tool pair | Span rejected; choose a balanced adjacent range. |
| Summarize call fails/truncates | Compaction returns "not compacted"; the turn proceeds on the existing context or fails closed on true overflow. A summary that is empty or image-only is rejected. |
| Repo map/LSP unavailable | Degrade to tree-sitter + lexical search; mark diagnostics unavailable. |
| Stale checkpoint | Rebuild prefers live state; checkpoints are versioned. |

## Direct Thread compaction (`DEC-075`, `REQ-CTX-013`)

Managed Run checkpoints preserve task-graph contracts and verifier evidence. An
ordinary coding conversation uses a lighter projection: retain a configurable recent
verbatim tail, then summarize older visible conversation as concise narrative and
structured references. The summary must preserve the original active request, later
user corrections, accepted decisions, current relevant files/errors/evidence, and
unresolved questions. It must not import goal/task headings when no managed Run exists.

This projection is disposable and rebuildable from canonical Thread events. It cannot
rewrite intent, approve effects, establish task completion, or serve as evidence. If
reconstruction is incomplete, report what could not be recovered and request user
input rather than inventing or resurrecting an old objective. Trigger and retained
tail size are selected from the resolved context budget and evaluated; no fixed turn
count is assumed to fit every provider.

## Optional hybrid repository retrieval (`REQ-CTX-014`)

Use three independently inspectable signals when enabled: lexical search for exact
identifiers/errors/paths, syntax and reference topology for symbol structure, and
local embedding retrieval for natural-language concepts. Semantic indexing is off by
default. The user can choose local-only embedding models and local storage; any
remote embedding route requires a separate explicit egress disclosure/approval and
must identify what repository content leaves the machine. Index updates are
incremental, cancellable, revision-bound, and run outside the interactive render and
model-stream path. PowerShell here is a command shell profile for `exec.run`, not a
special source-language indexing requirement.

The result identifies which signals contributed and their freshness. If embeddings,
parser, or graph data are missing/stale, fall back to labeled lexical search and direct
reads. Evaluate natural-language concept queries alongside exact-token queries,
including retrieval relevance, missed relevant files, indexing CPU/RAM/disk, and
first-use latency. No token-saving or correctness guarantee follows from a repository
map alone.

## Configuration

| Key | Meaning | Default |
|---|---|---|
| `compaction.auto` | enable automatic compaction | `true` |
| `compaction.auto_threshold` | context-window utilization at which automatic compaction starts | `0.5` |
| `compaction.buffer` | reserve subtracted from the window | `20000` |
| `compaction.keep.tokens` | serialized tail retained verbatim | `8000` |
| `compaction.summary.max_tokens` | summarize-call cap | `4096` |

| `tool_output.max_lines` | model-visible tool-output line bound | `2000` |
| `tool_output.max_bytes` | model-visible tool-output byte bound | `51200` |
| `repo_map.budget_tokens` | bounded repo-map allowance | finite route-bounded configuration |
| `context.eval_gate` | enable the retrieval-eval gate | `true` |

Config discovery follows ARCH/core/CONFIG.md’s authoritative scope precedence; values may have
validated per-model-class overrides without widening authority. No key changes an authorization decision (`CMP-guard` owns that).

## Requirements mapping

| Requirement | Where satisfied |
|---|---|
| `REQ-CTX-001` | Ranked repo map from the configured source view + language parsing (Repo map); every edge and excerpt carries freshness/provenance. |
| `REQ-CTX-002` | Trigger rule, serialized tail + structured summary (Token estimation and budget model; Compaction engine). |
| `REQ-CTX-003` | Eval-gated compaction, not window-fit only (Eval-gated compaction). |
| `REQ-CTX-004` | Pre-send estimate/hard fit guard and separately fenced pre-content provider rejection recovery (Token estimation and budget model; Compaction engine). |
| `REQ-CTX-005` | Hierarchical `AGENTS.md` discovery as a typed source (Instruction source assembly). |
| `REQ-PERF-003` | Incremental indexing off the loop (Repo map). |
| `REQ-ORCH-001/002/005` | Sharded child context + receipts (Sub-agent and worktree sharding). |
| `REQ-MEM-005..007` | Child ContextPackets use explicit bounded references and replay idempotency; optional profile memory is policy-gated, namespace-scoped, revision-pinned, and uses the canonical project identity/scope (Sub-agent and worktree sharding; [Memory](../product/MEMORY.md)). |
| `REQ-HORIZON-002` | The task graph survives compaction because canonical task state is reloaded from the durable run/task store; a context checkpoint may carry only a bounded, revision-bound summary/reference, never authoritative task truth. |
| `REQ-SEC-002` | Instructions/retrieved content framed as untrusted data. |

## ExecutionBrief and lifecycle hooks 

`ExecutionBrief` is a small deterministic rendering of current canonical state for a
new context epoch or post-compaction resume. It contains `run_id?`, `task_id?`, phase,
approved objective excerpt, completed milestones, key decisions, active blockers,
next safe action, referenced source revisions, and a digest. Build it from the
canonical approved `ExecutionPlan`, Task/Run events, current Evidence, and workspace
snapshot; do not persist it as a second plan or trust worker-authored prose. Persist
only the brief artifact reference/digest when required for epoch replay. Regenerate
when any source sequence/revision changes and fail closed on unresolved/stale inputs.

`ExecutionBrief` also binds schema version, source-head vector, scope, generation, ordered references and bounded excerpts. Direct turns derive it from admitted Thread/input state without fabricating Run/Task records. Missing or stale source heads yield typed unavailable/refresh-required; never an invented empty brief.

Context lifecycle events are typed (`ContextPressure`, `PreCompaction`,
`CompactionCommitted`, `PostCompactionResume`, `ModelChanged`, `WorkerChanged`,
`RecoveryResume`). Hooks may request bounded reassembly but cannot commit Run state,
change permissions, or select a different route without the existing owner. Preserve
the existing 50% automatic trigger and separate hard-fit/output reserve.


## Memory source selection

CMP-memory owns V2 admission/freshness and capture-generation fences. CMP-context records each selected source use as preference_hint, confirmed_preference, revalidation_lead or reviewed_note. Task instructions take precedence over stored preferences; current source/config evidence takes precedence over observations. Confidence only affects ranking. Before dispatch validate policy, scope, capture generation and selected revisions; forgotten/disabled sources invalidate the epoch for a subsequent request. Already-dispatched requests retain truthful provenance. Required memory omission blocks only when the admitted task actually requires that context; otherwise proceed with a visible omission. Memory content cannot grant permission, approve task truth or satisfy verification.
