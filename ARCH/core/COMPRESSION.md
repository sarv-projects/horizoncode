# Compression

This contract defines context selection, observation formatting, compaction and exact recall owned by CMP-context and CMP-artifact. Research evidence is retained outside the blueprint.

## Extractive vs abstractive (code vs prose)

- **Extractive** (select spans verbatim) preserves identifiers, hashes, versions, exit codes, and line numbers (`DEC-015`). Whether it reduces cost or preserves task quality is an empirical question. **For code, extraction and grouping are safer than rewording; neither is automatically safe** — one omitted condition or log line can change a diagnosis.
- **Abstractive** (generate a summary) is shorter and more readable for **prose** (issues, plans, discussions) but hallucinates: it merges versions, invents paths, and drops negations. Use it only for prose, **constrained by a schema** (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).
- **Hierarchical**: parent summaries of child summaries, retrieved at the right altitude. Failure mode is error propagation — keep leaf recovery (full log in the store, original diff in VCS) and version summaries.

## Chosen strategy (ordered)

1. **Provider-adapter-aware stable prefixes.** Keep HorizonCode's internal context projection deterministic, but let each adapter render the ordering and supported cache controls required by its wire API. Pin the exact serialized static prefix per context epoch; never claim a cache hit without provider usage evidence.
2. **Ranked repo map + JIT file access.** Do not load what you can select (`REQ-CTX-001`).
3. **Native deterministic observation formatters + full-output recall store**, per command family, **eval-gated** (`REQ-CTX-006`, `DEC-013`). Exact output remains retrievable through the existing artifact owner.
4. **Keep-tail + structured-summary compaction**, automatically triggered at the configured fraction of the active route's resolved model window (50% default). “Tool-result clearing” means removing an old completed tool observation only from the model-context projection after the exact bytes are committed, digest-verified, and pinned in `CMP-artifact`; the projection retains a bounded verbatim preview and immutable recovery reference. Canonical Thread events and artifact bytes are never cleared by compaction. Missing/expired reads are typed unavailable, not empty success. This step is not allowed for open/unsettled results or evidence under an active pin (`REQ-CTX-002`, `REQ-CTX-004`, `REQ-CTX-006`, `ARCH/core/CONTEXT.md`, `ARCH/core/TOOLS.md`, `ARCH/product/ARTIFACTS.md`). The output/buffer reserve remains a separate hard fit guard. Manual compaction is independent of the automatic trigger setting; setting automatic compaction off disables every automatic compaction/recovery path.
5. Warm-prefix summarization is a route-specific optimization subject to output validity and context-fit conformance; it never changes summary authority or recovery limits.
6. **Avoid:** depending on the external filter binary; any server-plane KV/gist technique; abstractive summarization of diffs/logs/build output as a default; any "compress harder" knob without a paired task-success gate.

## Quality acceptance

- **Paired per-task A/B** with a pre-registered sample size and endpoints. Three pairs are a smoke test only, not inferential evidence. Report all per-task observations, medians, pass-rate changes, uncertainty, resource use, and exclusions; do not present aggregate output-byte/token reduction as task-level cost savings.
- Suites: software-engineering task suites, terminal/agent benchmarks, and repo-continuity probes (can a post-compaction agent still recover decision X, file Y, error Z?).
- Operational metrics: cache-read %, turns-to-pass, summary-recovery hit rate, re-read rate.
- **Compressor-internal counters are not evidence** (`REQ-CTX-009`).

## Requirements mapping

`REQ-CTX-002`, `REQ-CTX-003`, `REQ-CTX-004`, `REQ-CTX-006`, `REQ-CTX-007`, `REQ-CTX-008`, `REQ-CTX-009`, `REQ-CTX-011`, `REQ-CTX-013` (see `ARCH/02-REQUIREMENTS.md`).

## Post-compaction rehydration 

Keep the recent tail verbatim and the middle as the existing bounded structured
summary. At the new epoch boundary, rebuild an `ExecutionBrief` projection from
canonical Run/Task/approved-plan/Evidence/workspace state (`ARCH/core/CONTEXT.md`). Pin its input
sequences, source revisions, and digest to `ContextEpoch`; on mismatch, regenerate or
surface a typed stale-state outcome before dispatch. Inject this bounded projection
once at the epoch boundary, not the complete planning history on each turn. Context
summaries and briefs never replace Thread events, plan/task owners, artifact truth, or
accepted memory. Existing fit, trigger, route pinning, and retry rules remain binding.


## Projection and recall semantics

Selection and summary are lossy prompt projections even when original bytes remain intact. Exact recall refers to the retained source, not a guarantee that every detail survived summarization. Ordinary context requires no remote index. Preserve the verbatim tail and balanced tool pairs, compress admitted historical content, then attest a bounded fresh ExecutionBrief once at the new epoch. Never inject full planning history every turn. Recall retention belongs to CMP-artifact. Every automatic path shares CMP-context eligibility and the persisted logical-step recovery allowance; auto=false prohibits automatic summary calls and retries.
