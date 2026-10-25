# Third-party architecture directive — verification against the HorizonCode repo

**Date:** 2026-10-25
**Verifier:** read-only verification subagent (no source edits, no Git mutation, no Cargo, no package-wide typecheck, no provider/network use).
**Authority used (in order):** root `AGENTS.md` → `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → the single normative topic owner per claim → exact local source/tests.
**Subject:** a third-party "architecture directive" (sections 2–35 as enumerated by the parent task). The directive itself is **not** in this repository; every verdict below is built from the claim list supplied in the task plus independent repo inspection. The directive is treated as **non-authoritative input**, exactly as `arch_V1/README.md:15` requires ("A research report, audit snapshot, archived plan, source repository, test result, or compatibility stub never overrides a normative topic owner").

**Classification vocabulary:** CORRECT · ADD-V1 · POST-V1 · REJECT/IGNORE.

---

## 0. Executive summary

| Area | Headline |
|---|---|
| Sec 2 invariants | All six match frozen law — **CORRECT**, nothing to do. |
| "Missing architecture" claims (Sec 4.1, 5, 6, 8, 9, 11, 14) | The **named types are genuinely absent** (confirmed), but in 6 of 7 cases the *requirement already exists* in a normative owner and/or acceptance row. Directive **overstates** the architectural gap; the real gap is code, not design. |
| Claims of things being missing that are **already built** | Sec 16 (post-patch diagnostics) is fully implemented; Sec 17 two-stage startup, Sec 18 critical-path law, Sec 20/21 activity+subagent UX, Sec 23 Explore, Sec 24 worktrees, Sec 25 worker admission are all specified and (mostly) coded. Directive **understates**. |
| Factually wrong premises | Sec 10 (unbounded queues) — no unbounded channel exists anywhere; Sec 34 (`dangerously`/`YOLO` "not present") — both flags already exist; Sec 14 briefing grep (no 4096/64 MiB in indexd) — constants exist as `4_096` / `67_108_864`. |
| Hard conflicts with frozen decisions | **Sec 27 status ladder (UNAVAILABLE vs RELEASED)**, **Sec 29 ("Windows is not later")**, **Sec 3 HLD diagram (Web/Desktop/Editor/ACP surfaces)**. Each loses to exact normative text quoted below. |
| Genuine new V1 work | ~8 narrow ADD-V1 items, all of which must be written into **existing** owners (17.6 / `README.md:100` forbid a new authority document). |

---

## 1. Section-by-section verdicts

### Sec 2 — Invariants → **CORRECT (all six)**

| Claim | Verdict | Evidence |
|---|---|---|
| 2.1 single mutation chain | CORRECT | `arch_V1/README.md:23` "Every mutation crosses the same Guard and authorized ExecutionHost path"; `17:57` (§17.3.4 "Mutations require Guard admission and a one-use execution lease"); `13:91-100` (§13.5 six-step mediation, "No Bun/worker/plugin side-channel may perform the same effect outside this path") |
| 2.2 UNKNOWN reconcile | CORRECT | `17:57` ("Unknown outcomes are reconciled, not blindly retried"); `17:201`; `21:119` ("UNKNOWN effect prevents blind retry"); `15:245`; `32:407` AU-014 |
| 2.3 pinned provider | CORRECT | `17:12` A-V2-03 "User pins provider/model/harness"; `17:62` §17.3.9; `17:101` DEC-V1-32; `17:527` §17.26 ("A direct request never falls back to a different provider, model, account, endpoint, or harness") |
| 2.4 model self-report ≠ evidence | CORRECT | `17:16` A-V2-08 "Model self-report cannot PASS a Run"; `17:120` "A Markdown contract, catalog row, schema, mock, benchmark claim or competitor feature never proves runtime support"; `17:220` "No model-authored PASS" |
| 2.5 context is a projection | CORRECT | `30:707` "ContextLedger is the only typed description of the *model-visible projection*, not a shadow conversation database"; `17:45` (§17.2 row: "Context view/selection metadata → ContextService"); `31:434` "The activity/task tree is a projection … never becomes a transcript, scheduler, or evidence store" |
| 2.6 no second authority | CORRECT | `README.md:100` "Never solve a conflict by adding another authority document"; `17:34` A-V2-26; `17:127` §17.6 |

Nothing to add. If the directive *proposes* these as new statements, that is harmless restatement; if it proposes them as a **new chapter**, REJECT (see Sec 30).

---

### Sec 4.1 — `ProgressGuardV1` / `ProgressObservationV1` / `ProgressStateV1` / NO_PROGRESS_WARNING → **ADD-V1 (implementation only; REJECT the new type/chapter)**

**Absence confirmed.** Repo-wide ripgrep for `ProgressGuard|no_progress|cyclePeriod|ProgressObservationV1|ProgressStateV1` returns **only** non-authoritative hits:
- `docs/architecture-archive/2026-10-11-pre-lean-consolidation/arch_V1/21-...md:52` (`if no_progress_detected()` — archived, non-normative per `README.md:59`);
- `docs/architecture-input/universal-software-agent-v2-source.md:1977` (retained source input, explicitly non-normative);
- archived `12-DOMAIN-SCHEMAS.md:13` (`RecoveryCaseV2.classification … 'no_progress'` — archived).
Zero matches in active `arch_V1/`, `packages/`, `kernel/`, `indexd/`.

**But the directive overstates "missing architecture."** The *requirement* is already normative and already has acceptance IDs:

| Existing owner | Text |
|---|---|
| `32:405` (§32.19 RC-002) | "same normalized error/no state change → **repeated strategy suppressed**" |
| `32:406` (RC-003) | "same error but source/test progress → **no false loop detection**" |
| `32:226` (§32.11 LM-007) | "tiny model repeats same bad edit → **loop detection/strategy change**" |
| `32:392` (AU-008) | "event-trigger loop → recursion/cycle bounded" |
| `30:466` (§30.13) | "cap repair attempts and **change strategy after repeated identical failure**" |
| `11:250` (§11.17 stop condition) | "repeated failures exceed bounded policy" |
| `21:5-25` (§21.1 healing tiers) | L1/L2 bounded retry; L4 post-V1 adaptive changes only |

**And the source itself carries the open work item:** `packages/core/src/session/runner/llm.ts:85` — `- [ ] Bound provider retries and repeated identical tool calls.`

Non-normative corroboration: `arch_V1/omp-tui-command-settings-inventory.json:2381` records an OMP feature "Detect consecutive identical tool calls across turns and inject a corrective steer" (research evidence only, per `17:632`).

**Verdict:** the A/B/A/B detector is genuinely **absent as code** → ADD-V1 (owner: §30.13 + §32.19 acceptance; backlog row already implied by `llm.ts:85`). **REJECT** `ProgressGuardV1`/`ProgressObservationV1`/`ProgressStateV1` as *new* architecture types/chapters — RC-002/RC-003/LM-007 already own the semantics, and `README.md:100` forbids a second document for it.

---

### Sec 4.2 — `CapabilitySnapshotV1` → **ADD-V1 (as the trusted runtime projection of the *existing* registry)**

**Absence of the exact name confirmed:** repo-wide `CapabilitySnapshotV1` → 0 matches (only archived `AgentCapabilitySnapshotV1` / `ProviderCapabilitySnapshotV1` in `docs/architecture-archive/.../12-DOMAIN-SCHEMAS.md:718,1019` and `.../20-OPENCODE-INTEGRATION-LLD.md:131,153` — non-normative).

**Already covered under other names (do not duplicate):**
- `packages/core/src/config/coding-profile.ts:17-31` — `CapabilityImplementationStatus = designed|code_present|wired|tested|verified|released` and `CapabilityDescriptorV1 { id, implementationStatus, supportedPlatforms?, disabledReason? }`.
- `arch_V1/contracts-v2/capability-registry-v1.json` — 230 canonical IDs, 226 `designed` / 4 `code_present` (counts re-verified by parse in `reports/audit-v1-tracker-reconciliation.md:77` and `arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md:44`).
- `33:702` §33.25 "Capability implementation status anchors"; `16:574` (§16.17) — every availability badge resolves DESIGNED/CODE_PRESENT/WIRED/TESTED + stability + platform + settings + health.
- `packages/schema/src/composition-v1.ts:189-197` — a *plugin-manifest* `CapabilityDescriptor` (different domain; do not conflate).

**Genuine gap, confirmed by the repo's own records:** there is **no trusted runtime producer** of the descriptor set. `HANDOFF.md:5478-5480`: "the Tools chip reports `effective unknown / catalog unknown` because no trusted client-side `CapabilityDescriptorV1` projection exists — **parent follow-up: route a trusted runtime capability projection (§33 registry + feature exposure) to an owner**"; same in `reports/phases/P4.md:1260`, `reports/phases/P6.md:1252,2152`, `reports/audit-v1-tracker-reconciliation.md:291`. Reinforced by `packages/opencode/src/session/tools.ts:67-72`, which currently hard-codes `implementationStatus: "wired"` for every capability — i.e. today's projection is *untrustworthy*, not merely absent.

**Verdict:** ADD-V1 — owner `33` (+ a `37` service interface + §32 acceptance). It must be the runtime projection of `capability-registry-v1.json` + feature exposure, **not** a new `CapabilitySnapshotV1` type or a second registry (`README.md:85`: "capability-registry-v1.json is a design/alias seed and must never create a second registry").

---

### Sec 4.3 — Tool/MCP discovery single-flight cache → **REJECT (as stated)**

Evidence:
- `packages/opencode/src/tool/discovery.ts` (197 lines) is **pure/synchronous**: canonicalization, `toolSchemaRecordV1`, `toolsetGenerationV1` (content-addressed generation key, lines 93-107), `searchToolDescriptorsV1`. No async work exists to coalesce; there is nothing a single-flight cache would deduplicate. A generation key already exists for cache identity.
- `packages/opencode/src/mcp/index.ts:21-22` — `CONNECTION_UNAVAILABLE = "MCP connections are unavailable until the canonical Rust execution broker supports MCP process and network effects."` MCP connect/list is currently **disabled**; caching an unavailable path is premature. Early-connection/lazy MCP is already an "Adopt behind benchmarks" item (`17:154` A-V2-28).
- `packages/opencode/src/skill/discovery.ts:35-47, 79-118` — a filesystem download cache (`Global.Path.cache/skills`, `exists → return true`, atomic rename/backup). Concurrent `pull()` could re-fetch the index; this is the only place coalescing would help, and it is minor.
- Precedent against over-applying single-flight: `30:797` — "HostKernel dispatch is synchronous … concurrent `ensure_generation` calls cannot overlap … **no in-flight singleflight map is required for this dispatcher**."

**Verdict:** REJECT for tool/MCP (pure sync path + disabled MCP + explicit contrary precedent). Optional narrow ADD-V1: coalesce the skill-index `pull()` only (owner `29` §29.6/`16` §16.11). Low priority.

---

### Sec 5 — Prompt/provider caching types + models.dev critical path

#### 5.a The four type names → **REJECT (all four are duplicates of existing §30/§37 contracts)**

All four names are ABSENT (verified: `PromptSegmentV1|PrefixFingerprintV1|CacheBreakObservationV1|ProviderCacheProfileV1` → 0 matches repo-wide), **but each maps 1:1 onto an existing normative contract**:

| Proposed type | Already owned by | Evidence |
|---|---|---|
| `PromptSegmentV1` | `ContextLedgerEntryV2.cacheClass` | `30:55` (`cacheClass?: "static"\|"history"\|"turn"\|"attachment"\|"none"`); `arch_V1/contracts-v2/context-ledger-v2.schema.json:71`; **live code** `packages/schema/src/context-ledger-v2.ts:38`, set in `packages/opencode/src/session/llm.ts:483,503`, `packages/core/src/session/runner/llm.ts:512`, `packages/core/src/session/project-instruction.ts:678`; rendered by `packages/tui/src/component/prompt/index.tsx:315`. §30.11 (`30:419-425`) already enumerates the stable segments. |
| `PrefixFingerprintV1` | `PrefixCachePlanV1.breakpoints[].segmentDigest` + `CacheKeyV1` family `provider_prefix` | `37:3686-3701` (`segmentDigest: string // blake3 of normalized block bytes`); `30:710-716` (`CacheKeyV1.family … "provider_prefix"`, `providerRouteDigest`, `promptPolicyDigest`); `30:736` ("only cache an immutable prefix for the **same** provider/account/model/harness/tokenizer/policy/source epoch"); live `promptCacheKey` in `packages/core/src/session/runner/llm.ts:667,684` |
| `CacheBreakObservationV1` | `§37.14 CacheObservationAdapterV1` | `37:1737-1741` (map `cache_read/cache_write/input/output` after each SETTLED request, "no observed cache" never a fabricated hit); `30:427` ("Analytics records whether the provider reported cache reads/writes/hits"); acceptance `32` CX-013/CX-017 (`32:204`) |
| `ProviderCacheProfileV1` | `ContextCompilePolicyV1.prefixCacheSupport` + `catalogHints` | `arch_V1/contracts-v2/context-compile-policy-v1.schema.json:8-40` (`prefixCacheSupport: none\|ephemeral\|explicit_breakpoints\|unknown`, `catalogHints`); resolver `37:3663-3681`; live resolver `packages/core/src/session/context-compile-policy.ts:118` |

`30:1163` already states precisely what is and is not wired: "**CODE_PRESENT / PARTIAL:** `ModelsDev.Service`, `compileContextLedgerV2`, `ContextSelection` pin … **Not yet wired:** `resolveContextCompilePolicyV1`, `RepoContextAnchor` generation, `PrefixCacheAdapterV1`, ledger `compilePolicy`, profile `contextCompilePolicy`, `CX-014`..`021`."

**Verdict: REJECT (four duplicate type names).** The correct move is to *finish §30.26/§37.30*, not to introduce parallel types. New names for existing contracts would create exactly the second-authority condition `17:127` and `README.md:100` forbid.

#### 5.b §5.5 "never fetch models.dev live in critical path / bundle a snapshot" → **CORRECT (already implemented exactly that way)**

- `packages/core/src/models-dev.ts:171-172` — `get()` / `getSnapshot()` read-only; `refresh()` "Fetches only when an explicit refresh action invokes it."
- `models-dev.ts:295-305` — `populate` = disk cache → bundled `OPENCODE_MODELS_DEV` snapshot → `{}`; memoized with `Effect.cachedInvalidateWithTTL(..., Duration.infinity)`. **`get()` never touches the network.**
- `models-dev.ts:362-379` — `refresh` guarded by `Flag.OPENCODE_DISABLE_MODELS_FETCH`, 5-minute freshness short-circuit, `Flock` cross-process lock with re-check, and `Effect.ignore` + `logError` on failure → **last-known-good retained on offline/fetch failure**.
- `packages/core/src/plugin/models-dev.ts:182-185` — "**One bounded metadata refresh attempt per process start** (A-V2-27 amendment, SRC-028). A cache inside the freshness window short-circuits, offline/fetch failure keeps the last known-good snapshot" — launched with `Effect.forkScoped({ startImmediately: true })`, i.e. **background**, not critical path. Success publishes `Refreshed` → integration/catalog reload (`plugin/models-dev.ts:178-181`).
- Normative source: `17:143` (Provider-source amendment, 2026-10-23) — "one bounded refresh is attempted at startup, and the last known-good cache is the fallback"; `30:971` (catalog rows advisory with source/freshness from `getSnapshot()`); `30:1138`.
- Snapshot size bound: `models-dev.ts:25` `MAX_CATALOG_BYTES = 16 MiB`, enforced at `models-dev.ts:259-261`.

**Verdict: CORRECT — already async/background with bundled snapshot + last-good fallback.** No work.

---

### Sec 6 — Cache-safe progressive tools vs §30.5 → **ADD-V1 (narrow rule, existing owner)**

What exists:
- `30:213-228` §30.5 "Progressive tool exposure" — minimal starter surface; "`tools.search(query)` returns compact tool descriptors … the next provider turn pins the expanded toolset generation."
- `33:596` (§33.21) — "Results are top-K bounded and can expose a requested family **at the next safe toolset boundary**."
- `17:582-589` (§17.28) — "It does not send the full capability catalog on every request. Long-tail capabilities use progressive search/describe and become model-visible **only at a safe request boundary**."
- **Code:** `packages/opencode/src/session/tools.ts:362` starter set, `:395` rehydration from committed `tools_search` results, `:500` `initial = buildToolset(...)`, `:508-512` `prepareNextProviderRequest()` merges `stagedCapabilities` **once, at the next request boundary**. So expansion is already *batched to request boundaries*, and each build pins a `toolsetGenerationV1` (`tools.ts:413`).

Is the design cache-hostile? **Partially yes, and the directive is right about the *hole* — but wrong to imply nothing was considered:**
- `30:1030` (§30.26.4 `cache_anchor`) requires the stable prefix — anchor, **harness**, static system — to be "identical bytes across turns in same anchor epoch"; `37:3705` restricts breakpoints to `cacheClass: "static"` segments. Tool definitions ride in the harness/tool projection, so any expansion **changes `tools[]` bytes → prefix miss** on a cache route.
- §30.26.5 (`30:1056-1067`) explicitly protects against *repo-map* intent churn ("Bug avoided … changes prefix bytes → cache miss") but **no equivalent rule exists for tool-set churn**. Nothing states that expansion must be epoch-aware, monotone, or recorded as an invalidation.

**Verdict:** ADD-V1 — one rule added to `30.26.4`/`37.30.2`/`33.21`: expansion is either deferred to an anchor-epoch boundary, or treated as a declared prefix invalidation (telemetry + honest "cache not observed"). No new type, no new owner.

---

### Sec 7 — `QueryPurpose` → **ADD-V1 (narrow, additive field only)**

- Absence confirmed: `QueryPurpose` → **0 matches** repo-wide.
- `ContextCompilePolicyV1` does **not** scope by request kind: schema fields are only `schemaVersion, requested, effective, resolvedFrom, prefixCacheSupport, catalogHints` (`arch_V1/contracts-v2/context-compile-policy-v1.schema.json:8-40`); resolver input `packages/core/src/session/context-compile-policy.ts:71-118` has no purpose/kind dimension.
- Existing, adjacent scoping dimensions (do not duplicate): `ContextSpeedPlanV1.toolBias` (`context-compile-policy.ts:517-549`), `HarnessProfileV1` (`29:169-215`), exposure tiers `33:839` (§33.32), §30.5 layers, §33.20 default tool exposure by agent, §30.26.4 route-driven tiers.
- §30.26.5 already isolates query-dependent bytes into the **tail** (`30:1065` "Query-specific retrieval … compiles into tail sources only"), which covers part of what a `QueryPurpose` would be for.

**Verdict:** ADD-V1, but strictly as an **optional field on the existing `ContextCompilePolicyV1`** (owner `30` §30.26 + schema + §32 CX rows). A standalone `QueryPurpose` type or a second compile policy REJECTED (`17:589` "without a second prompt builder").

---

### Sec 8 — Compaction recursion guard + circuit breaker → **ADD-V1 (narrow; directive overstates the gap)**

Guards that already exist:

| Guard | Evidence |
|---|---|
| Refuse to compact if the summary prompt itself will not fit | `packages/core/src/session/compaction.ts:217` — `if (Token.estimate(summaryPrompt) > context - summaryOutput) return false` |
| **One-shot overflow recovery, second overflow is fatal** | `packages/core/src/session/runner/llm.ts:1192-1204` — `runAfterOverflowCompaction` → `Effect.die("Post-compaction provider attempt cannot recover another overflow")` at `:1198`; `:279` "rebuild **once** through the path without overflow recovery" |
| Transcript truncates at the compaction record (converges) | `packages/core/src/session/history.ts:27-40` — only messages `seq >= compaction.seq` are loaded |
| Auto-trim runs **once per epoch** | `compaction.ts:271-290` (`autoTrimedEpochIDs`, §30.4 step 0) |
| Test coverage | `packages/core/test/session-runner.test.ts:1963,1981,2037` — "forces one compaction and retries after provider context overflow" |

Genuine remaining gap: the **`ContinueAfterCompaction` path has no recursion bound** — `runner/llm.ts:1206-1218` re-enters `runTurn(...)` with no counter, and there is no cross-turn circuit breaker (N compactions per turn/time window). If system+tools alone exceed the budget while a prior summary exists, `compactAfterOverflow` can return `true` again (`compaction.ts:211` only bails when `selected.head.length === 0` **and** there is no previous summary).

**Verdict:** ADD-V1 — bounded recursion + a per-turn/per-epoch compaction circuit breaker in `runner/llm.ts`, acceptance added under §32.10 (CX rows) or §32.19 (RC rows). The directive's "missing" claim is **partially overstated**: the dangerous one-shot overflow loop is already terminated hard.

---

### Sec 9 — IPC wire-level traffic classes → **REJECT as new architecture (semantics already normative; chunking already exists)**

Absence of the *names* confirmed: `CONTROL|DURABLE_EVENT|NORMAL_RPC|PROJECTION|BULK_DATA`, `DATA_START|CHUNK|END` → 0 matches in `arch_V1/13-COMPOSITION-IPC.md` and `kernel/src/protocol_framing.rs`.

But the directive's citation of `kernel/src/protocol_framing.rs` as the IPC location is **mis-scoped**: that file (192 lines) is *"Bounded Content-Length framed JSON parser for supervised LSP/DAP stdio"* (line 1) — it is not the Core↔HostKernel IPC. The real IPC is `kernel/src/transport.rs` (4-byte big-endian length prefix, `MAX_FRAME_SIZE = 8 MiB`) + `kernel/src/protocol.rs` (`HzKernelRpcV1`).

What `13` already specifies today:

- `13:218` (**§13.12, normative priority law**): "**Priority order:** durable cancellation/lease revocation/receipt acknowledgement > Guard mutation admission > Session snapshot/control > derived telemetry/paint. Use bounded weighted fair scheduling, **not** a global FIFO where a noisy Session starves cancel. Reject with typed queue capacity status when full; **never queue an unbounded full prompt/raw tool stdout in Rust**." — this *is* the CONTROL / DURABLE_EVENT / NORMAL_RPC / PROJECTION / BULK_DATA taxonomy, minus the literal enum names.
- `13:191` (§13.11): "bounded per-session mailboxes, fair queues, backpressure and priority for cancellation/receipts … Durable control/effect events never disappear because UI paints were dropped."
- `13:216`: "fair credits and per-attachment output quotas"; "One slow Session must not block another."
- `13:200`: extension rule — "**No second private protocol.** Extend current authenticated, length-prefixed MessagePack `HzKernelRpcV1` only through a feature-negotiated, versioned operation family."

**Chunked bulk transfer already exists** (just not named DATA_START/CHUNK/END):
- `kernel/src/protocol.rs:156` `MAX_ARTIFACT_CHUNK_BODY_BYTES = 768 * 1024`; `:5487-5491` `validate_artifact_chunk_body` ("Applies the stricter chunk-body ceiling for the dedicated artifact-transfer …").
- `kernel/src/host_kernel.rs:4711-4718,4774-4779` — `store.read_range(...)` returning `offset`, `nextOffset`, `complete`, `bytes`: an existing offset/continuation chunk protocol for artifact bytes.

**Side finding (real defect, not from the directive):** `13:200` claims `MAX_BODY_BYTES = 1 MiB`; the code says `kernel/src/protocol.rs:153` `pub const MAX_BODY_BYTES: usize = 6 * 1024 * 1024;` (and `MAX_EVENT_PAYLOAD_BYTES = 256 KiB` matches at `:154`). The doc line "Respect those hard limits; do not silently expand them" is therefore already stale → needs a `13` owner correction under `17:127`.

**Verdict:** REJECT the five-class taxonomy + chunk protocol as new architecture (already specified by `13:218` and already implemented for artifacts). Residual ADD-V1 only if/when the §13.11 shared-kernel multiplex is actually built: explicit class tags in the negotiated operation family, owned by `13` §13.11–13.12. Separate doc-fix: correct `13:200`'s `MAX_BODY_BYTES`.

---

### Sec 10 — Bounded queues → **REJECT (factually wrong premise)**

The directive's premise (unbounded queues exist) is **not supported by any evidence I could find**:

| Location | What is actually used |
|---|---|
| `kernel/` entire tree | **No `mpsc::unbounded_channel()`, no `tokio::sync`, no `flume`, no `futures::channel`.** The only channel in the whole kernel is `kernel/src/http_execution.rs:13` + `:1507` — `let (send, receive) = mpsc::sync_channel(1);` (bounded, capacity 1). IPC is synchronous length-prefixed request/response, not a channel fan-out. |
| `kernel/src/subscription.rs:14,77-168,218` | `MAX_SUBSCRIPTION_WINDOW = 256`; `queued`/`in_flight` `VecDeque`s with `if self.buffered() >= self.capacity` reject + `available_capacity()` |
| `kernel/src/session_projection.rs:17-19` | `MAX_BATCH = 4096`, `MAX_DATA_BYTES = 16 MiB`, `MAX_SUBSCRIPTION_PAGE = 256` |
| `kernel/src/transport.rs` | `MAX_FRAME_SIZE = 8 MiB` hard frame cap |
| `kernel/src/host_kernel.rs:2470` | `max_queued_tickets: worker_pool::MAX_QUEUED_TICKETS` |
| `packages/core/src/session/supervisor.ts:4076` | "server exceeded the **64-event delivery window**"; `:4928` terminal event capacity "between 1 and 128"; `:4957,4995` "terminal event stream exceeded its bounded capacity"; `:3661` "The buffer is bounded and marked truncated rather than unbounded" |
| SSE/event admission (`31:368`) | frozen JSON DTO under 64 KiB / 8,192 nodes / depth 32, plus 65,536-node aggregate and **2 MiB serialized-byte budget** |
| Render queue (`31:291`) | cap **1024 replaceable paint deltas per Session**, durable cursor preserved separately |
| `indexd/` | no channels at all; bounded constants only (`indexd/src/lib.rs:54-66`) |
| Normative law already present | `13:218` "never queue an unbounded full prompt/raw tool stdout in Rust"; `13:191` "global overload must reject new work with a typed outcome rather than buffering indefinitely"; `18:299` pressure controller |

The only `unbounded` occurrences in Core are **Effect concurrency selectors** (`concurrency: "unbounded"` at `supervisor.ts:3027,6934`, `runner/llm.ts:294`), which are bounded by their input array size — these are not queues.

**Verdict: REJECT (factually wrong).** No unbounded fan-out found; the property the directive asks for is already enforced in code and law.

---

### Sec 11 — Durability classes (EFFECT_BARRIER/CONTROL_CRITICAL/DURABLE_NORMAL/DERIVED) → **ADD-V1 (narrow, strictly non-authoritative only)**

- Absence confirmed: all four names → 0 matches in `arch_V1/` and `kernel/src`.
- What exists today is a **single uniform, fail-closed durability law**: `18:21-29` (§18.2) — "Acknowledge durable commit only after the configured backend's required data/directory synchronization succeeds"; "If a platform cannot meet the required durability guarantee, the dependent managed capability is unavailable rather than silently weakened."
- The OwnerLog append path **does** fsync: `kernel/src/owner_log.rs:950,953` (segment `sync_all`), `:988,991` (temp file + head), `:1865,1883,1911` (directory/file sync helpers); likewise `kernel/src/effect_host.rs:1164-1172,1253-1263` and `kernel/src/artifact_store.rs:1156,1267-1271,1312`.
- So there is **no tiering** — everything authoritative is synced per append. The four-class proposal is genuinely new.

**Verdict:** ADD-V1, with a hard constraint: only data that is *already non-authoritative/derived* (indexd rebuildable generations, render/derived caches) may use a weaker class, and the mapping must be recorded in `12` (`12.16` machine schema) and `18.2` under the existing `17:127` change procedure. Any attempt to relax `EFFECT_BARRIER`/`CONTROL_CRITICAL` equivalents = REJECT (would contradict `18:25` and `17:57`).

---

### Sec 12 — Cancellation process tree → **CORRECT (largely already implemented); residuals are test-only + platform-gated**

Verified in `kernel/src/terminal_process.rs`:

| Claim | Evidence | Status |
|---|---|---|
| `libc::setsid()` | `:4357`, `:4491` | present |
| Parent-death kill | `:4512-4513` `PR_SET_PDEATHSIG` / `SIGKILL` | present |
| Process-group kill | `:4202-4203` ("The leader called setsid, so its PID is also its session/process-group ID" → `kill(-leader, SIGKILL)`), `:4567`, `:4633`, `:4639` | present |
| Subreaper + escapee sweep | module header `:6-8`; `:4319-4322` "owner loss … triggers a bounded kill and sweep of the whole tree"; `:4642` "Reap every dead child: the leader (zombie or killed) and adopted orphans" | present |
| Escapee tests | `:6582` `owner_loss_terminates_escaped_session_descendants`, `:6599` `owner_close_terminates_escaped_session_descendants`, `:6615` `observed_exit_waits_for_escaped_descendant_quiescence` (uses `/usr/bin/setsid … &` and `exec sleep 300`) | present |
| PID-reuse safety | `read_starttime` guards **in the kill path**: `:4198`, `:4392` + `:4565` (`if read_starttime(leader) == Some(leader_start)`), `:4629` (group entries matched by `(pid, ppid, pgrp, starttime)`); `:4660` `/proc` scan; also `kernel/src/resource_sampler.rs:1297,3037`, `kernel/src/unix_peer.rs:31,426` | implemented in source |
| Windows Job Object | `#[cfg(windows)]` `:5106-5222` (`CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`), `:5501-5542`, `:5660` | code present, **cannot run on Linux** |
| Deadline-bounded silent reads | `:6044` `silent_terminal_output_read_never_blocks_deadline_or_cancel_polling` | present |

**What is actually proven vs. remaining:**
- Proven by source+tests (not run by me — no Cargo permitted): escapee termination on owner loss / owner close / observed exit.
- **Not proven:** (a) a dedicated test asserting a PID-reused pid/group is *not* killed (the starttime guards are untested); (b) a "grandchild retains the pipe after owner exit" case — `:6615` covers an escaped descendant's quiescence but not an inherited-fd holder; (c) **Windows Job Object is entirely unexercised** and native Windows is frozen unavailable (`17:183` A-V2-31; also DEC-V1-01 `17:71`, DEC-V1-17 `17:86`, `13:194` "WSL results do not qualify native Windows").

**Verdict:** CORRECT as an accurate description of the mechanism; to the extent the directive claims this is *missing*, REJECT (it exists). Residuals: ADD-V1 for the two missing Linux negative tests (owner `14`/`32`), POST-V1 for Windows qualification (A-V2-31).

---

### Sec 13 — `EffectClass` / `ConcurrencyClass` / `ResourceFootprint` → **SPLIT: EffectClass CORRECT; the other two REJECT**

| Type | Verdict | Evidence |
|---|---|---|
| `EffectClass` | **CORRECT — exists, but with three non-identical enums already in the tree** | `arch_V1/12-DOMAIN-SCHEMAS.md:25` canonical: "`EffectClass: READ_ONLY, CONTROL or EFFECT`"; `packages/core/src/tool/tool.ts:11` runtime: `"read_only" \| "control" \| "effect" \| "unknown"` (used at `:15`, and as `capability: { id: "files.patch", effectClass: "effect" }` at `packages/opencode/src/tool/apply_patch.ts:478`); `packages/schema/src/composition-v1.ts:94-97` **a different, plugin-manifest-scoped** `EffectClass = query\|local_preference\|guarded_effect\|control` (consumed by `OperationDescriptor.effectClass`, `:196`). Directive's claim that it exists in `composition-v1.ts` is true but that file's members are **not** the canonical ones. Also `17:63` "Unknown capability/effect class fails closed." |
| `ConcurrencyClass` | **REJECT** | ABSENT (0 matches). But concurrency/admission is already governed by `18:275-279` `BudgetDimension = memoryBytes\|cpuMillicores\|processes\|fds\|diskBytes\|toolOutputBytes\|**activeWorkers**\|tokens\|providerCostMicros`, `21:124-147` (§21.10 sampling/backpressure + §21.11 `AcquireResourceLease`), `17:410` §17.19 (WorkerPool ceiling ∩ `maxWorkers`), `15:241`. A new scheduling-flavoured enum would be a **second concurrency vocabulary**. If a per-capability *hint* is wanted, it belongs as metadata inside `33` capability records — not a new type. |
| `ResourceFootprint` | **REJECT (duplicate)** | ABSENT, but already covered three ways: `18:277-283` `ResourceLimitV1{dimension, soft, hard, source, enforcement}`, `arch_V1/contracts-v2/resource-policy-v1.schema.json` (`dimensions`, `enforcementStrength`), `resource-sample-v1.schema.json` (`metricId/unit/value/quality/osMethod/processStartIdentity`), `resource-reservation-v1.schema.json` (`limits`, `processStartIdentity`); plus `CodeModeResourceProfileV1` (`12:1086,1109`). §18.18 (`18:270-376`) is the sole owner. |

**Side finding:** the three-way `EffectClass` divergence (§12 vs `tool.ts` vs `composition-v1.ts`) is a **pre-existing ambiguity worth a §12/§17 clarification** — the plugin-manifest enum shares a name with the canonical one. This is a repo defect, not a directive win, but the directive is right to notice it.

---

### Sec 14 — Scalable indexd → **ADD-V1 (scale-up) — and the briefing's grep was wrong**

**Actual limits found in `indexd/src/lib.rs:54-66`:**
```rust
pub const MAX_BASE_FILES: usize = 4_096;
pub const MAX_FILE_BYTES: usize = 1_048_576;        // 1 MiB
pub const MAX_BASE_CONTENT_BYTES: usize = 67_108_864; // 64 MiB
pub const MAX_BASE_PATH_BYTES: usize = 4_194_304;    // 4 MiB
pub const MAX_OVERLAY_FILES: usize = 128;
pub const MAX_OVERLAY_CONTENT_BYTES: usize = 8_388_608; // 8 MiB
pub const MAX_QUERY_RESULTS: usize = 100; MAX_QUERY_WORK_UNITS: 4_194_304
```
Also `indexd/src/generation_store.rs:21-24` — `MAX_PERSISTED_GENERATIONS = 128`, `MAX_PERSISTED_BYTES = 536_870_912` (512 MiB), `MAX_SCANNED_FILES = 512`.

⇒ The directive's "**~4,096 files / 64 MiB**" is **exactly right**; the parent briefing's grep ("NO 4096/64MiB/max_files in `indexd/src/*.rs`") failed because the literals are written `4_096` / `67_108_864`. **The directive is CORRECT here and the briefing was wrong.**

**50K+ target already normative:** `30:409` "50K+ file repositories require bounded queues, ignored-directory rules and memory limits"; `32:441` (§32.21) "50K-file index build + incremental update"; `30:740` §30.21 "Indexd exact baseline … These are **per-index operational limits**, not total process RAM targets".

| Sub-claim | Verdict | Evidence |
|---|---|---|
| 14.3 tree-sitter LRU | **ABSENT** — and moot until parsers exist | `indexd/src/lib.rs:220,229` `tree_sitter: false`; no `lru` string anywhere in `indexd/src`; `30:519` "The local `indexd` implementation is currently only a bounded lexical slice; it must not be reported as this complete service until persistence, **parsing/symbols**, watcher lifecycle and LSP integration are actually wired and verified"; `30:369-370` "Parser-backed definitions, symbol outlines, impact graphs and resolved reference edges report unavailable because no approved parser/index provenance is wired". (An LRU *does* exist for the cache registry family: `30:734` size-aware LRU + `18:299` LRU eviction by family — different scope.) |
| 14.4 shared watcher | **PARTIALLY present** | Host side: `packages/core/src/filesystem/watcher.ts` — `@parcel/watcher` (inotify/fs-events/windows), built with `makeLocationNode` ⇒ **one watcher per location, shared across Sessions of that directory** (not per session), gated behind `Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER` (`watcher.ts:114-118`) ⇒ **experimental, defaults OFF** per A-V2-29. indexd side: `indexd/src/watch.rs:43-44` "**Bounded event coalescer. It owns no OS watcher and starts no background work; the host watcher feeds events and polls `take_due`**" — passive, and **no producer currently feeds it** (no `WatchBatcher` usage outside indexd itself). |
| 14.6 partial readiness | **PRESENT (implemented)** | State machine `30:398-403` (ABSENT→BUILDING→CURRENT→STALE→PARTIAL→FAILED→RETIRED); `indexd/src/watch.rs:130-138` `LifecycleState{Absent,Building,Current,Stale,Partial,Failed,Retired}`; `indexd/src/lib.rs:344-347` `fn status() -> GenerationStatus { GenerationStatus::Partial }` — the lexical index **honestly always reports Partial**; `30:405` "initial index streams useful partial results; user does not wait for full repository indexing to chat". |

**Verdict:** ADD-V1 for the bounded scale-up to 50K+ files (owner `30` §30.10 + `indexd`; acceptance `32:441`) — note this is **already V1 scope**, so it is "finish the existing requirement", not new scope. Parser+LRU is DESIGNED under §30.8/§30.9 but blocked on parser provenance; shared-watcher *feeding* into indexd is not wired.

---

### Sec 15 — `EditProtocolProfile` / `HASH_ANCHOR` → **CORRECT as "adopted behind benchmarks"; REJECT as a new type**

- `EditProtocolProfile` → **0 matches**; `HASH_ANCHOR` → **0 matches** (repo-wide).
- The mechanism is fully owned already: `17:154` A-V2-28 "**Adopt behind benchmarks:** source-revision-safe **Hashline** as an edit dialect **within `files.patch`**"; `03:183` "Hashline/native editing is an implementation strategy inside the same files.patch contract"; `10:63` "Hashline-style stale-edit strategy **inside files.patch, not a second editor API**"; `20:147`; `33:126` (`files.patch` row: "Hashline / revision fence inside patch path"); `30:1202` ACC-G "every write carries revision/hashline fence; mismatch → typed retry"; `42:134-140` SRC-003 immutable pin (`can1357/oh-my-pi@eec114a…/crates/pi-edit/src/modes/hashline/patcher.rs`, "Extract algorithm/logic … choose edit mode for model"); `32:711` FEAT-009.
- Feature surface exists and is **OFF**: `packages/core/src/v1/config/feature-exposure.ts:14,74,278-279` (`hashline_edit`, "Hashline edit dialect"), design-only example `16:457`, `16:465` "experimental native-search, **hashline-edit**, and CoW descriptors stay OFF and unavailable".
- **Current status = adopted-behind-benchmark, NOT implemented** (no hashline code in `packages/` or `kernel/`; only the feature descriptor + provenance pin). This matches the directive.
- **But stale-edit fencing itself IS implemented:** `packages/opencode/src/tool/apply_patch.ts:40-46` `repoIntelFence` (`queryID, sourceGeneration, sourceRevision, workspaceBinding, {pathRef,fileDigest}|{expectedAbsent}`) and per-target `expectedBeforeBase64` preconditions (`:62,87,117,314-338`).

**Verdict:** CORRECT (status = adopted-behind-benchmark / experimental-OFF). REJECT `EditProtocolProfile`/`HASH_ANCHOR` as new names: `03:183`/`10:63`/`20:147` already fix the dialect *inside* `files.patch`.

---

### Sec 16 — Diagnostics piggyback after edit → **REJECT (already implemented and specified)**

The directive understates the repo:

- **Code:** `packages/opencode/src/tool/apply_patch.ts:434-471`:
  - `:434-439` "// Notify LSP of file changes and collect diagnostics" → `lsp.touchFile(target, "document")`;
  - `:440` `const diagnostics = yield* lsp.diagnostics()`;
  - `:455-462` appends `"\n\nLSP errors detected in ${rel}, please fix:\n${block}"` to the tool output;
  - `:464-471` returns `metadata: { diff, files, diagnostics }`.
- **Spec:** `30:1201` (§30.29 ACC-F) "after `files.patch`, schedule bounded LSP `diagnostics.get`; **surface in tool result**; optional one repair turn (user setting)"; `33:506` "post-patch diagnostics scheduling"; `30:932` "LSP diagnostic loop | P4 broker: publish buffer → diagnostics → session runner bounded repair"; `10:258` §10.18.2 same.
- **Tracked as landed:** `arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md:31` — "W-P4-05 | not done | **post-patch diagnostics wired in `apply_patch.ts:434-469` + `lsp/diagnostic.test.ts`**".

Honest caveat (does not rescue the claim): `30:519`/`30:799` record that `packages/opencode/src/lsp/lsp.ts` currently has **no process clients**, so diagnostics can be empty in practice — but that is a P4 wiring gap, not a missing *design* or missing *piggyback code*.

**Verdict: REJECT (already implemented + already specified).**

---

### Sec 17 — Two-stage startup → **CORRECT (already specified, largely implemented)**

- `13:32-46` (§13.2) nine-step startup: config roots → private kernel endpoint → OS peer auth → Hello negotiation → STARTING → observer validation → **READY with capabilities** → "Host exposes only capabilities whose required owners are READY" → "**Core opens a pooled, session-warm authenticated IPC handle** … provider-only turns do not pay per-turn handshake cost"; and crucially `13:45-46`: "Application/effect RPC is rejected before READY. **Provider inference and context compile are not blocked on kernel READY**; only effect RPC and managed control require READY." **That is the two-stage (fast-interactive / late-effects) startup law.**
- **Code:** `kernel/src/startup.rs:13-25` `StartupPhase{AwaitingPeerAuthentication, AwaitingHelloNegotiation, AwaitingCanonicalStateValidation, AwaitingOwnerEpoch, Reconciling, AwaitingRequiredServices, Ready, Fenced, Failed}` with `StartupTransitionError::ApplicationRpcBeforeReady` (`:29-34`); `kernel/src/protocol.rs:5573-5840` `STARTING`/`READY` `KernelStartupStatusV1`; host side `packages/core/src/session/supervisor.ts:3704-3750` `waitForSocket(...)` (timeout, "supervisor exited before securing its socket"), `:3849-3899` `startupStatus() → "starting"|"ready"|"failed"`, `startupTimeoutMs = 10_000`.
- A *different* "two-stage" also already exists and is far more detailed: `21:323-371` (§21.14 "Two-stage managed pre-admission reservation", Stage A reserve → Stage B context-bind → admission) and `37:2038` (two-stage pre-admission handoff).

**Verdict: CORRECT — the content the directive proposes is already specified (and the process part is coded).** No new work. If presented as "missing", that is an overstatement.

---

### Sec 18 — Critical-path law → **CORRECT (already specified)**

- `15:215-224` (§15.16 Performance): "Critical path should avoid: loading entire architecture; loading entire logs; spawning new processes for simple native reads where a safe existing service is faster; redundant model calls; unnecessary worktrees. Use measured budgets in 31 and release tests in 32."
- `15:252` (§15.20): "**Direct mode must remain cheap**: no automatic Goal, spec acceptance, Task DAG or 20 worker pool solely to answer a normal coding question."
- `13:45-46` (kernel off the provider path); `30:944-949` (§30.26.1 goals: maximize useful work per token without switching route or building a second prompt builder); `31:66` (warm-kernel read fast path); `32:1323` PERF-DIRECT-001 "kernel not on critical path".

**Verdict: CORRECT, already stated in `15` (and `13`, `30`, `32`).** REJECT any re-statement as a new section.

---

### Sec 19 — Performance SLOs (p95 25 ms key→frame etc.) → **ADD-V1 (narrow: fold into §31.3 only; REJECT a new SLO authority)**

Budgets that already exist:

| Budget | Value | Owner |
|---|---|---|
| keystroke/input response p95 | **< 50 ms** | `31:62` (§31.3) |
| local UI/status round trip p95 | < 150 ms | `31:63` |
| warm shell usable | "a few seconds" | `31:64` |
| first paint of code block in viewport | ≤ **8 ms p95** | `31:763` |
| review overlay on 5k-line diff | interactive ≤ 200 ms | `31:766` |
| shell card title refresh | ≤ 250 ms | `31:740` |
| Guard overhead before spawn (warm kernel) | ≤ **40 ms** | `31:876`, `32:1325` |
| challenge UI paint | ≤ 150 ms | `31:877` |
| active stream redraw / idle / deep idle | 1 frame ≈ 16 ms / 250 ms / 5000 ms after 30 s | `31:291` |
| direct parity (relative) | p95 send→first-byte **+5%** of baseline; read phase **+10%** | `32:1323-1324` (PERF-DIRECT-001/002) |
| release gates | startup, keystroke/UI latency, streaming, compile, index, Guard/IPC/effect, rendering, memory, concurrency | `18:105-120` (§18.8) |
| suites | cold/warm startup, first prompt, **50K-file index**, 1K/10K transcript, 1/4/16 fanout, tool catalog 20/100/500, context compile 4K–128K | `32:434-452` (§32.21) |

- **`p95 25 ms key→frame` appears nowhere.** No 25 ms figure in `31`, `docs/performance/README.md`, or `scripts/perf/rc0.py`.
- `docs/performance/README.md` is explicitly "**not normative architecture**" (a measurement runbook; `README.md:106` repeats that it is "a **measurement runbook only**, not an additional owner").
- `scripts/perf/rc0.py:1-20` — RC0 harness; all captures labeled `provisional_raw_sample` / `NOT_BASELINE`, `release_eligible: False`, attestation allowlist empty → **RC0 is NOT_ATTESTED**.
- **Reality check:** `46-V1-IMPLEMENTATION-BACKLOG.md:38-40` — "**0 of 6 `PERF-DIRECT-*` rows have ever been executed** — no p95/baseline number exists anywhere in `reports/`". Budgets are *targets*, none measured.

**Verdict:** a "25 ms key→frame" figure is **tighter than the existing 50 ms keystroke budget** and would be a *change to a frozen budget* (`17:24` A-V2-16 "Performance budgets are release architecture"). → ADD-V1 **only** as an amendment to `31` §31.3 following `17:93-98` (decision update in `17` + owner update + `32` acceptance). Any separate SLO table/document = REJECT (second authority).

---

### Sec 20 / 21 — UI + subagent UX → **CORRECT (already specified and largely built)**

Already present in `arch_V1`:
- `31:431` §31.21 usage + agent activity presentation ("compact footer … bounded inspectable detail and attributed child/task activity"; "The activity/task tree is a projection … never becomes a transcript, scheduler, or evidence store").
- `31:484-494` "Permission friction and subagent activity in the V1 TUI" (child Sessions and DAG nodes as attributable activity rows; inspect/message/wait/interrupt/cancel).
- `31:495-749` §31.22 Activity card presentation — `ActivityCardV1`, screen layout, tool→card mapping, visual language, expanded preview, review overlay, coalescing, focus/keyboard contract, diagnostics, hard limits (`31:582` max 64 cards/turn, 256 sliding window, 64 KiB preview).
- `31:751-852` §31.23 fast code display/diff/highlight RAM bounds; `31:854+` §31.24 direct-mode latency.
- `16:733-776` §16.21 session layout/pane stack; `16:572-594` §16.17 exact resource & concurrent-session UI (incl. "Add headless specialist", "Experimental shared kernel" rows).
- Acceptance `32` §32.48 `ACT-001..024` (`31:444`).

Already present in code (`packages/tui/src/component/` + `routes/session/`):
`activity-cards.ts`, `activity-stream.tsx`, `dialog-agent.tsx` (agent hub), `dialog-subagents.tsx`, `dialog-subagent-message.tsx`, `routes/session/dialog-subagent.tsx`, `subagent-footer.tsx`, `dialog-goal-run-plan.tsx`, `dialog-status.tsx`, `dialog-debug.tsx`, `prompt/index.tsx` (cache chips at `:315-316`).

**Verdict: CORRECT / already built — REJECT as missing.**

---

### Sec 23 / 24 / 25 — Explore path, worktree rules, worker admission → **CORRECT (all three already specified; Explore also exists in code)**

| Claim | Evidence |
|---|---|
| 23 cheap Explore path | `29:216-236` (§29.3 built-in specialists) — `builtin.explorer` "repository discovery \| read/index/LSP only \| **fast/small preferred**"; `21:128` "A read-only analysis worker should not allocate a worktree or full independent app runtime"; `33:549` read-only profile tool list. **Code:** `packages/opencode/src/agent/agent.ts:328-347` — `explore` subagent, `permission: { "*": "deny", grep/glob/list/read/bash/webfetch/websearch: "allow" }`, description "Fast agent specialized for exploring codebases". Residual: `options: {}` means **no cheaper model is bound** — the "cheap" part is design-only (`29:224` "fast/small preferred"). |
| 24 worktree rules | `17:13` A-V2-05 "Worktrees are pooled, leased, capped and quarantined when dirty — No unbounded worktree creation/deletion"; `21:52-74` §21.4 pool; `21:146` (never delete/reuse dirty worktree); `21:158` "Never release a dirty worktree merely because a Session tab is closed"; `21:167+` §21.12 tombstones; `17:414` §17.19 (worktree ID/base-revision only from eligible P8-registered clean worktree); `17:472-491` §17.23 guarded managed worktree lifecycle; `16:586` cleanup row ("never 'clean all'"). |
| 25 worker admission | `21:124-132` §21.10 (sample memory/CPU/FDs/disks/concurrency/collision cost → reserve → backpressure → cancel only owned disposable workers); `21:134-158` §21.11 `AcquireResourceLease(expectedTaskVersion)` six steps incl. §11.20 `PROPOSED→RESERVED→CLAIMED→RELEASE_PENDING→RELEASED`, `EXPIRED`, `QUARANTINED`; `17:408-414` §17.19 (bounded by WorkerPool ceiling ∩ accepted `maxWorkers`; explicitly "bounded scheduling/accounting, **not** an OS resource limit"); `29:731` §29.13; `29:801` §29.18; `18:270+` §18.18. |

**Verdict: CORRECT / already specified — REJECT as missing.**

---

### Sec 27 — Implementation-proof registry + ladder `…→ UNAVAILABLE` → **REJECT (hard conflict)**

**Exact normative text that wins:**
- `AGENTS.md:276` — "Statuses are distinct: `DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED.`"
- `AGENTS.md:229` — the orchestration states "track orchestration only and **do not replace the canonical feature statuses** DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED."
- `arch_V1/17-GOVERNANCE-DECISIONS.md:123` (§17.5 Evidence law) — "Statuses are distinct: DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED."
- `arch_V1/17:177` (A-V2-30 "No artificial omission") — "statuses `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED` are stated honestly."

⇒ **`…→ UNAVAILABLE` conflicts with the frozen ladder. REJECT.**

**Important nuance the directive half-stumbled onto (pre-existing repo defect):** `arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md:5` says "Runtime status must be one of `DESIGNED | CODE_PRESENT | WIRED | TESTED | VERIFIED | **UNAVAILABLE**`" — i.e. `33` and `17`/`AGENTS.md` already disagree. And the machine schema is a *third* variant: `arch_V1/contracts-v2/capability-registry-v1.schema.json:49-57` `status.enum = [designed, code_present, wired, tested, verified]` — **no `released`, no `unavailable`** — while `packages/core/src/config/coding-profile.ts:17-23` has `CapabilityImplementationStatus = designed|code_present|wired|tested|verified|released` (six, matching `17`). Fix under `17:127` (change `17` + the single owner), **not** by adopting the directive's ladder.

**Machine-readable registry already exists** (so "propose a registry" is largely moot):
- `arch_V1/contracts-v2/capability-registry-v1.json` + `.schema.json` (230 canonical + aliases; 226 `designed` / 4 `code_present`), `arch_V1/generated-capability-ids.txt`, `46-V1-FEATURE-INVENTORY.md:7`.
- `arch_V1/46-V1-WIRE-TRACKER.md` (own status legend: Not done / Partial / Done / N/A) and `arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md` (DES / CP / PART / OPEN), `46-V1-VERIFICATION-RUNBOOK.md`, `46-V1-DESIGN-AUDIT.md`, `46-V1-SOURCE-ALIGNMENT-AUDIT.md`, `46-V1-MIGRATION-PARITY.md`.
- `reports/phases/LEDGER.md` (phase orchestration ledger with the AGENTS.md state vocabulary).
- `arch_V1/contracts-v2/` (≈70 machine schemas + fixtures).

**Verdict: REJECT** on three grounds: (1) ladder conflict with `AGENTS.md:276` + `17:123,177`; (2) a *new* registry duplicates `capability-registry-v1.json` and violates `README.md:85` ("must never create a second registry"); (3) a seventh status vocabulary on top of the four already in-tree worsens the real problem, which is **alignment**, not invention.

---

### Sec 29 — "Windows is not later" → **REJECT (hard conflict)**

**Exact normative text that wins:** `arch_V1/17-GOVERNANCE-DECISIONS.md:183` (A-V2-31, user-approved 2026-10-16 scope decision): "**Keep native Windows unavailable until native tests pass.**"

Supporting: `17:71` DEC-V1-01 (Windows sandbox guarantees → "Do not claim sandboxed effects without native acceptance"); `17:86` DEC-V1-17 (durable Windows event-store sync → "Durable managed Windows Runs unavailable"); `13:194` "Windows named-pipe/ACL and storage semantics need independent proof; **WSL results do not qualify native Windows**"; `18:190` §18.13 platform support truth; `10:158` (test Linux/Windows clean install only as a *release* task, not a qualification claim).

**Verdict: REJECT.** Only a future `17` decision can change this.

---

### Sec 3 — HLD diagram listing Web/Desktop/Editor/ACP surfaces → **REJECT (hard conflict)**

The directive's HLD presents surfaces that frozen decisions declare post-V1 / unavailable:

| Surface in directive | Normative text that wins |
|---|---|
| Web / Desktop / browser automation / desktop control | `17:183` (A-V2-31): "Web, desktop, browser automation/attached-browser and desktop/computer control are **post-V1 and unavailable in V1**"; `17:26` A-V2-18 (browser/DOM post-V1); `10:148` §10.12; `10:269-271` §10.18.4 |
| ACP surface | `17:93` DEC-V1-24: "ACP adapter §37.20–21 design stays **post-V1** per A-V2-31"; `10:207`: "external ACP protocol/client integration is post-V1"; "the existence of OpenCode's ACP server does not fulfill Horizon's outbound adapter" (`10:212`) |
| Horizon-as-MCP-server | `17:92` DEC-V1-23: "Server mode unavailable in V1; MCP remains client-side" |
| Editor/IDE integration | `17:93` DEC-V1-24: "No editor-integration claim in V1" (only the opt-in external-editor profile of DEC-V1-33, `17:102`) |
| Deployment | `10:210`: "production/provider deployment journeys are post-V1. Keep remote mutation unavailable" |

**Verdict: REJECT.** Any diagram that shows these as active V1 surfaces misrepresents the frozen scope; the V1 HLD may show them only as *explicitly unavailable/post-V1* nodes.

---

### Sec 30 — Per-file `arch_V1` changes → **MOSTLY REJECT; ~6 items may be written into existing owners**

I could not read the directive's per-file text (not in repo), so I assessed each *named* item from the other claims against the owning file:

| Target file | Proposed content (as inferred) | Verdict |
|---|---|---|
| `30-CONTEXT-INDEXING-LOCAL-MODELS.md` | prompt/prefix/cache-break/provider-cache types | **REJECT** — §30.19 (`30:691`), §30.21 (`30:705-746`), §30.11 (`30:413-429`), §30.26 (`30:938-1163`) + `37:14`/`37:30` already own them |
| `30` (same) | `QueryPurpose` | **ADD-V1** — as an optional field of `ContextCompilePolicyV1` in §30.26 |
| `30` (same) | cache-safe progressive tools | **ADD-V1** — one rule in §30.26.4/§33.21 |
| `30` (same) | indexd 50K+ scale | **ADD-V1** — §30.10 already demands it; finish, don't re-scope |
| `13-COMPOSITION-IPC.md` | 5 traffic classes + chunking | **REJECT** — `13:218` already has the priority law; artifact chunking exists (`protocol.rs:156`, `host_kernel.rs:4711`). *Separate real fix:* `13:200` `MAX_BODY_BYTES` is stale (code = 6 MiB) |
| `12-DOMAIN-SCHEMAS.md` | `EffectClass` | **CORRECT (exists, `12:25`)** — plus a real cleanup: three non-identical `EffectClass` enums |
| `12` | `ConcurrencyClass`, `ResourceFootprint` | **REJECT** — duplicate §18.18 (`BudgetDimension`, `ResourceLimitV1`, `resource-sample-v1`) |
| `18-OPERATIONS-RELEASE.md` | durability classes | **ADD-V1 (narrow)** — only for provably non-authoritative/derived data; §18.2 unchanged for the rest |
| `31-UI-PERFORMANCE…` / `15-RUNTIME-EXECUTION.md` | SLO table (25 ms key→frame) | **ADD-V1 (narrow)** — only by amending §31.3; `15:217`/`15:252` already state the law |
| `16` / `31` §31.22-31.24 | activity cards / subagent UX | **REJECT** — already specified + coded |
| `21` / `37` | two-stage startup | **REJECT** — §13.2 + §21.14 + code |
| `29` | Explore/worktree/worker rules | **REJECT** — §29.3/§21.10/§21.11 |
| `33` | status ladder incl. UNAVAILABLE | **REJECT** — conflicts with `17:123`; fix alignment instead |
| `46-V1-*` | new implementation-proof registry | **REJECT** — 7 files + `capability-registry-v1.json` already exist |

**Governing rules for anything admitted:** `17:93-98` (material change = decision in `17` + **single topic owner** + affected schemas/IDs + `32` acceptance + delivery order), `17:127` ("A true conflict is resolved by changing this file and the single topic owner, **not by appending another audit chapter**"), `README.md:100`.

---

### Sec 32 — POST-V1 list → **CORRECT (all seven verified as frozen post-V1)**

| Item | Frozen basis |
|---|---|
| ACP | `17:93` DEC-V1-24; `10:207`; `10:212` |
| plugin bundle | `17:74` DEC-V1-04 ("No unreviewed executable marketplace activation"); `17:75` DEC-V1-05 ("WASM extension unavailable"); `10:271` "Wasmtime plugin VM (`DEC-V1-05`); kernel Rhai/Lua scripting" post-V1. *Imprecise caveat:* ordinary (non-WASM, in-tree) plugins are **in** V1 (`packages/core/src/plugin/*`, `13:114` registry owner) — only *bundled/remote/WASM plugin runtimes* are post-V1 |
| best-of-N | `17:156` A-V2-28 "**Defer as defaults:** parallel best-of-N or 8 workers …" |
| deployment monitors | `10:210` "production/provider deployment journeys are post-V1 … preserve DEP-001..008 as future acceptance" |
| cross-repo | `17:86` DEC-V1-14 "Local-only authority"; `17:104` DEC-V1-35 "Do not add a second repository index/graph authority" |
| remote workers | `17:86` DEC-V1-14 (remote/cloud continuation post-V1); `46-V1-FEATURE-INVENTORY.md:16` "Remote clients" = Post-V1; `17:172` (shared kernel is benchmark-gated, "not existing behaviour") |
| browser | `17:26` A-V2-18; `17:183` A-V2-31; `10:271` "Headless browser/Playwright visual QA" |

**Verdict: CORRECT.**

---

### Sec 33 — DEFER list → **SPLIT: 3 correct, 2 imprecise, 4 no-ops**

| Item | Verdict | Evidence |
|---|---|---|
| snapcompact | **CORRECT / POST-V1** | `17:157` "**Snapcompact:** DEFERRED/UNAVAILABLE in V1, not merely default-off … neither is implemented"; `30:177`; `16:516` §16.15.2 |
| embeddings (as *default*/baseline) | **CORRECT** | `17:22` A-V2-14 "symbol-first RepoIntel; **embeddings optional** — Opening a repo never requires embeddings"; `30:314` "optional semantic embeddings only when explicitly enabled"; `10:265` opt-in local embeddings = "nice to have"; `10:271` "default team cloud embeddings" post-V1; `17:104` DEC-V1-35 "no default remote embedding sync" |
| shared kernel | **IMPRECISE — do not classify as flatly deferred** | `17:172` A-V2-30: candidate "is a **benchmark-gated implementation direction**"; `13:187` "Evaluate a single reusable `hz-kernel` service *behind* `SessionSupervisor.Service`"; `13:222` migration sequence steps 1-6 (read-only multiplex prototype + negative tests are **in-scope evaluation**); `10:189-190` R1.1/R1.2 are V1 slices; `16:585` even has an "Experimental shared kernel" UI row. Only the **effectful cutover** is gated |
| prewarmed pool | **IMPRECISE** | Pooling/warm reuse is V1: `21:126` (pool warm compatible workers), `21:150` (worker-reuse keys), `15:243` (prewarm allowed lazily under permission/privacy rules); `17:197` says a *setting change* must not warm a model (a consent rule, not a deferral). "Long-lived shared services do not imply unbounded worker concurrency" (`17:174`) is a bound, not a deferral |
| mmap owner-log | **REJECT / no-op** | `mmap` appears exactly once in all of `arch_V1` (`31:817`, a UI anti-pattern note). Nothing designed ⇒ nothing to defer |
| zero-copy IPC | **REJECT / no-op** | 0 matches (`zero-copy`/`zerocopy`) in `arch_V1` or `kernel/` |
| DecisionService | **REJECT / no-op** | 0 matches repo-wide |
| memory graph | **REJECT / no-op** | 0 matches; nearest concepts are §30.20 recall and §30.15 named memory blocks, which are V1-opt-in |
| 120 Hz | **REJECT / no-op** | 0 matches; nearest is `31:291` "one frame per ~16 ms" ≈ 60 Hz render cap |

---

### Sec 34 — DO-NOT-ADD list → **SPLIT: 3 correct, 2 wrong (one contradicts a frozen decision)**

| Proposed ban | Verdict | Evidence |
|---|---|---|
| `dangerously…` | **FACTUALLY WRONG (already present)** | `packages/opencode/src/cli/cmd/run.ts:251-256,273-275,1003-1004` (`--dangerously-skip-permissions`, hidden alias of `--auto`, "auto-approve permissions that are not explicitly denied (**dangerous!**)"); `packages/opencode/src/cli/cmd/tui.ts:113-118,294` |
| `YOLO` | **FACTUALLY WRONG + conflicts with a frozen decision** | Flags at `run.ts:248-250,1002`, `tui.ts:113`; **and** `17:12` A-V2-04 "Ask, Safe Auto, **YOLO-in-sandbox** are presentation modes over one Guard"; `17:97` DEC-V1-28 (Full access mode); `14:19` "**YOLO is not root access**"; `05:30`; `16:311`. A blanket "never add YOLO" contradicts frozen law; the correct rule is already written: *no mode bypasses immutable denies* |
| unbounded queues | **CORRECT (absent, and already forbidden)** | see Sec 10 — `13:218` |
| path mutex as authority | **CORRECT (absent as authority)** | advisory locks exist but are not authority: `kernel/src/artifact_store.rs:820`, `kernel/src/supervisor_lease.rs:4` ("process-held advisory lock"); authority is Guard (`17:57`, `13:91-100`) |
| LLM-as-judge | **PARTIALLY WRONG as phrased** | a `judge` workload role already exists (`16:175`); `17:78` DEC-V1-08 "Verifier independence by risk tier → Distinct execution/read-only evidence; **label same-model limitation**" (i.e. model-based verification *is* allowed when labeled); `17:154` adopts "optional read-only independent verifier". The inviolable rule is `17:16` A-V2-08 — *model self-report cannot PASS a Run* — which is already enforced. Restate the ban in those terms or it collides with DEC-V1-08 |
| embeddings baseline | **CORRECT** | `17:22` A-V2-14; `17:104` DEC-V1-35 (no default remote embedding sync); `10:271` |

---

### Sec 35 — Phase 0–10 order vs `arch_V1/10` §10.18.1 → **REJECT as a competing order (and unverifiable as written)**

The operative orders, by name:
- `10:213` (§10.16): "**The single operative dependency order is P0–P9 plus RC0–RC5 in the current plan**; `implementationtov1release.md` owns the user-requested V1 scope/status crosswalk."
- `17:104` DEC-V1-35: "V1 release-critical work is the **ordered adaptation list in §10.18.1**: finish P1–P9 wiring and acceptance using pinned OpenCode/OMP/Codex patterns."
- `10:236-250` §10.18.1 — an **11-row priority table** (1 P1 Guard/parity → 2 P2 managed → 3 §30 context/cache → 4 P3 RepoIntel → 5 P4 LSP/DAP/REPL → 6 P5 web search → 7 P6 providers/settings → 8 P7 TUI → 9 P8 resources → 10 DEC-V1-28/29 grants+CodeMode → 11 P9 release), each with owner + acceptance trace.
- `17:185` (A-V2-31): "The order remains P1.3 Guard → P2 single managed vertical → bounded worker fan-out and remaining feature modules; **no effectful origin becomes available before Guard proof**."
- `10:169` §10.14: "**Preserve the P0–P9 dependency order**".

⇒ Any "Phase 0–10" scheme that is not a 1:1 renaming of P0–P9/§10.18.1 is a **second delivery order** and REJECTS on `17:104` + `10:213`. Because the directive's actual phase table is not in the repository, I could not diff it row-by-row (see §4 "could not verify").

---

## 2. Consolidated table (a) — ADD-V1 candidates

| # | Item | Proposed owning `arch_V1` file (existing owner only) | Why it qualifies | Acceptance hook |
|---|---|---|---|---|
| A1 | Loop/progress detection + bounded strategy change (implement, don't re-design) | `30` §30.13 (+ `21` §21.1 for the retry tier) | Type absent; requirement already normative; source TODO `runner/llm.ts:85` | existing `32:405-406` RC-002/RC-003, `32:226` LM-007 |
| A2 | Trusted **runtime capability projection** (registry + feature exposure → consumer) | `33` (§33.25/§33.28) + `37` service interface | No trusted producer today (`HANDOFF.md:5478-5480`); current code hard-codes `"wired"` (`tools.ts:71`) | new `32` rows beside §33.26; must not create a second registry |
| A3 | Cache-safety rule for progressive tool expansion (epoch-aware, or declared invalidation) | `30` §30.26.4 + `33` §33.21 | Expansion changes `tools[]` bytes → prefix miss; §30.26.5 covers repo-map but not tools | `32` CX-014..021 extension |
| A4 | Optional request-purpose dimension **as a field of** `ContextCompilePolicyV1` | `30` §30.26 (+ schema `contracts-v2/context-compile-policy-v1.schema.json`) | Genuinely absent; no second compile policy allowed (`30:949`) | `32` CX rows |
| A5 | Compaction recursion bound + cross-turn circuit breaker | `30` §30.4 (behavior) / code `runner/llm.ts:1206-1218` | One-shot overflow guard exists; the `ContinueAfterCompaction` path has none | `32` §32.10 or §32.19 |
| A6 | indexd bounded scale-up toward the 50K+ requirement (queues, ignore rules, memory caps) | `30` §30.10 (baseline constants at `30:740`) | Requirement already normative; limits are 4_096 / 64 MiB today | `32:441` 50K-file index suite |
| A7 | Durability class split for **provably non-authoritative/derived** data only | `18` §18.2 + `12` §12.16 | Uniform fsync today; tiering is new; must not weaken authoritative paths | `32` durability/restart rows |
| A8 | Explicit traffic-class tags in the (future) shared-kernel multiplex, if built | `13` §13.11–13.12 | Priority *semantics* already exist; wire tags do not; must use the §13.12 feature-negotiated family | `13:196` versioned schema + §32 |

*Also admitted as narrow test-only work:* A9 — PID-reuse kill negative test + grandchild-retained-pipe test for `kernel/src/terminal_process.rs` (owner `14`/`32`). *Also admitted as a doc fix:* A10 — correct `13:200` `MAX_BODY_BYTES` (doc says 1 MiB, code says 6 MiB at `kernel/src/protocol.rs:153`).

**Every A-item must be written into the existing owner per `17:93-98` / `17:127` / `README.md:100`. No new chapter.**

---

## 3. Consolidated table (b) — POST-V1 (confirmed)

| Item | Frozen basis |
|---|---|
| ACP outbound client/adapter | `17:93` DEC-V1-24; `10:207` |
| Web / desktop / browser automation / desktop-control surfaces | `17:183` A-V2-31; `17:26` A-V2-18; `10:148`, `10:271` |
| Horizon-as-MCP-server | `17:92` DEC-V1-23 |
| Deployment/visual-edit journeys (DEP/VIS) | `10:210`, `10:209` |
| best-of-N / 8 workers as defaults | `17:156` A-V2-28 |
| WASM / bundled executable plugin marketplace, kernel scripting | `17:74-75` DEC-V1-04/05; `10:271` |
| Remote/cloud continuation, remote workers, remote clients | `17:86` DEC-V1-14; `46-V1-FEATURE-INVENTORY.md:16` |
| Cross-repo / second index / default cloud embeddings | `17:104` DEC-V1-35; `10:271` |
| snapcompact | `17:157` A-V2-28; `30:177`; `16:516` |
| Native Windows qualification / Job Object acceptance | `17:183`; `17:71`; `17:86`; `13:194` |
| TypeScript build-graph/project-reference optimization | `10:154-157` (explicit post-V1 TODO, distinct from the V1 naming migration) |
| Shared-kernel **effectful cutover** (only the cutover) | `13:222` sequence step 5-6; `17:172` "benchmark-gated … not existing behaviour" |
| L4 adaptive self-improvement / autonomous policy change | `17:25` A-V2-17; `21:22-25` L4 |

---

## 4. Consolidated table (c) — REJECT / IGNORE

| # | Claim | Reason | Winning text |
|---|---|---|---|
| R1 | Sec 27 ladder `…→ UNAVAILABLE` | Conflicts with the frozen feature ladder; would also be a 7th status vocabulary | `AGENTS.md:276`, `AGENTS.md:229`, `17:123`, `17:177` |
| R2 | Sec 27 "new implementation-proof registry" | Machine-readable registries already exist; second registry forbidden | `README.md:85` ("must never create a second registry"); `capability-registry-v1.json` (230/226/4); `46-V1-WIRE-TRACKER.md`; `46-V1-IMPLEMENTATION-BACKLOG.md`; `reports/phases/LEDGER.md` |
| R3 | Sec 29 "Windows is not later" | Directly contradicts a user-approved frozen decision | `17:183` "Keep native Windows unavailable until native tests pass" |
| R4 | Sec 3 HLD with Web/Desktop/Editor/ACP as live surfaces | All four surface families frozen post-V1/unavailable | `17:183`, `17:92`, `17:93`, `17:26`, `10:207-212` |
| R5 | Sec 10 "unbounded queues" premise | Factually wrong — no unbounded channel/fan-out exists; property already enforced | `kernel/src/http_execution.rs:1507` (only channel, cap 1); `subscription.rs:14,156`; `supervisor.ts:4076,4928`; `13:218` |
| R6 | Sec 5 four cache types (`PromptSegmentV1`, `PrefixFingerprintV1`, `CacheBreakObservationV1`, `ProviderCacheProfileV1`) | Duplicate names for contracts already owned and partly coded | `30:55`+`context-ledger-v2.ts:38`; `37:3686-3701`; `37:1737-1741`; `context-compile-policy-v1.schema.json:8-40` |
| R7 | Sec 16 "diagnostics piggyback missing" | Already implemented and tracked as landed | `apply_patch.ts:434-471`; `30:1201`; `33:506`; `46-V1-IMPLEMENTATION-BACKLOG.md:31` |
| R8 | Sec 15 `EditProtocolProfile` / `HASH_ANCHOR` as a new protocol | Dialect must live inside `files.patch`; already "adopt behind benchmarks" | `17:154`, `03:183`, `10:63`, `20:147`, `33:126` |
| R9 | Sec 9 five traffic classes + chunk protocol as new architecture | Priority law already normative; artifact chunking already implemented | `13:218`; `protocol.rs:156`; `host_kernel.rs:4711-4718` |
| R10 | Sec 13 `ConcurrencyClass`, `ResourceFootprint` | Duplicate of §18.18 dimensions/limits/samples → second scheduling vocabulary | `18:275-283`, `resource-{policy,reservation,sample}-v1.schema.json` |
| R11 | Sec 4.3 tool/MCP single-flight cache | Pure sync path; MCP disabled; precedent says no singleflight needed | `tool/discovery.ts` (pure); `mcp/index.ts:21-22`; `30:797` |
| R12 | Sec 34 DO-NOT-ADD `dangerously` / `YOLO` | Both already exist; a ban contradicts A-V2-04/DEC-V1-28 | `run.ts:248-275`; `tui.ts:113-118`; `17:12`; `17:97`; `14:19` |
| R13 | Sec 34 DO-NOT-ADD "LLM-as-judge" as phrased | A `judge` role and labeled same-model verification are already allowed | `16:175`; `17:78` DEC-V1-08 — restate as A-V2-08 |
| R14 | Sec 35 Phase 0–10 order | Competing delivery order | `10:213` "single operative dependency order is P0–P9 plus RC0–RC5"; `17:104` §10.18.1; `17:185` |
| R15 | Sec 30 new chapters for any of the above | No new authority documents | `17:127`; `README.md:100` |
| R16 | Sec 33 DEFER entries for mmap / zero-copy / DecisionService / memory graph / 120 Hz | Nothing designed ⇒ nothing to defer; asserting a deferral implies a prior design | 0 matches repo-wide |
| R17 | Sec 17/18/19/20/21/23/24/25 "missing" framing | Already specified (and largely coded) | `13:32-46`, `15:217-224`, `31:59-70`, `31:495+`, `29:216-236`, `21:52-158` |

---

## 5. Claims I could NOT verify (and why)

1. **The directive's literal text is not in this repository.** I searched `reports/`, `docs/`, `specs/`, `arch_V1/` and all `*.md` modified in the last two days for `ProgressGuardV1`, `DO-NOT-ADD`, `NO_PROGRESS_WARNING`, `EFFECT_BARRIER`, `DATA_START`, `CODE_PRESENT … UNAVAILABLE`, "Phase 0" tables — no directive document found. Every verdict is therefore against the **claim list in my task**, not the directive's own wording. Section-level paraphrases (Sec 30 per-file proposals, Sec 35 Phase 0–10 table) could not be diffed item-by-item.
2. **Sec 30 exact per-file diff** — inferred from the other claims; I cannot confirm which additional files/sections the directive names.
3. **Sec 35 Phase 0–10 table** — I can state the rule (must be P0–P9 + RC0–RC5 / §10.18.1) but cannot check row-by-row mapping without the table.
4. **Exact enum members the directive proposes for `EffectClass`/`ConcurrencyClass`/`ResourceFootprint`** — unknown; I compared only against what the repo has.
5. **Performance numbers** — no benchmark was run (Cargo and package-wide typecheck were forbidden). I verified *budgets on paper* only. Note for the record: `46-V1-IMPLEMENTATION-BACKLOG.md:38-40` says **0 of 6 `PERF-DIRECT-*` rows have ever been executed** and RC0 is `NOT_ATTESTED`.
6. **Whether the terminal escapee/Windows tests actually pass** — they exist as `#[test]` / `#[cfg(windows)]` source (`terminal_process.rs:6582,6599,6615`, `:5106+`); I did not (and may not) run Cargo.
7. **Live MCP/tool discovery runtime behavior** — MCP is disabled at source (`mcp/index.ts:21-22`), so there is no runtime to observe; conclusions are source-based.
8. **Directive "Sec 2 invariants" wording** — I matched each invariant to frozen law; if the directive states any of them *differently* (e.g. adds a 7th invariant), that nuance is invisible to me.

---

## 6. Notes for the orchestrator

- **Two pre-existing repo defects surfaced, independent of the directive:** (i) `arch_V1/33:5` says the status set ends in `UNAVAILABLE` while `17:123`/`AGENTS.md:276` say `RELEASED`, and `capability-registry-v1.schema.json:49-57` omits **both**; (ii) `arch_V1/13:200` documents `MAX_BODY_BYTES = 1 MiB` while `kernel/src/protocol.rs:153` is `6 MiB`. Both need owner fixes under `17:127`, not a new document.
- **One real code-level TODO confirmed:** `packages/core/src/session/runner/llm.ts:85` "Bound provider retries and repeated identical tool calls" — this is the concrete home for A1.
- **One unbounded-recursion suspicion to hand to the owning phase:** `runner/llm.ts:1206-1218` re-enters `runTurn` on `ContinueAfterCompaction` with no counter (A5). I did not prove it loops; I proved there is no bound.
- **Concurrency discipline respected:** P1 (`packages/opencode/src/server`, `packages/core/src/session/supervisor.ts`), P7 (`packages/tui`) and P2 (`kernel/**`, `managed-control.ts`) were read only; no writes outside this report.
