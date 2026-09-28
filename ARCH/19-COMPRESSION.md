# 19 — Context Compression: Evidence and Chosen Strategy

This document answers *"check, don't just implement"* for context compression. It records what was investigated, what the evidence actually shows, and the strategy the context engine (`CMP-context`, `ARCH/09`) must implement.

## 1. The named tool, identified

The user named **"RTK compression"**. The current upstream README describes an Apache-2.0 Rust command-output proxy that filters supported shell command results before they enter model context, with per-command transformations and optional hooks. It explicitly says its advertised reductions apply to command output and are not equivalent to invoice savings; its token estimate uses `bytes / 4` ([upstream README](https://github.com/rtk-ai/rtk)). This is the upstream's description, not an independent measurement.

The documented transform families include:

- **filtering** — keep the signal fields, drop boilerplate;
- **grouping** — collapse repeated findings by file/module;
- **truncation** — bound long lines and windows;
- **deduplication**.

Output recall and hook coverage are features described by upstream documentation; before any interoperability or implementation decision, verify current behavior against the pinned source and test it. Hooks may only rewrite the command the user/agent requested through an explicitly governed route: the wrapper must preserve argv boundaries, exit status, stderr/stdout semantics, cwd and environment, and must not bypass HorizonCode's guard, sandbox, or audit.

**Evidence limit.** This audit found no independently reproducible task-level benchmark sufficient to conclude that an output filter lowers cost per verified task. Do not repeat marketing reduction percentages as savings. Measure total input/output/cache tokens, task success, output recall, retries, latency, and invoice amount on the same tasks. A formatter is a lossy projection and must keep the exact full output retrievable; missing or expired source output makes a filtered result unsuitable as sole verification evidence.

**Conclusion — adopt a pattern for evaluation, not a dependency by default.** Prototype deterministic per-command formatters with a full-output recall store; do not shell out to an external binary from inside the trusted core. An optional external tool integration is separately permissioned and audited. Compaction, prompt caching, and output formatting affect different portions of cost and must be evaluated together and separately.

## 2. The field, ranked by evidence strength

| Technique | Compresses | Runs | Lossy | Fit for a remote-API Rust CLI |
|---|---|---|---|---|
| **Prompt caching** (stable prefix, explicit breakpoint) | Repeated stable-prefix processing; billing/latency only where provider documents the effect | Provider adapter | No (exact reuse) | Implement only for documented route capabilities; comparative savings are unmeasured here |
| **Ranked repo map + just-in-time reads** | What is loaded at all | Client | No (selection) | **Adopt** — avoid loading, don't compress |
| **Deterministic observation formatters + recall** | Tool observations | Client | Yes, recoverable | **Adopt** (eval-gated per family) |
| **Keep-tail + structured-summary compaction + tool-result clearing** | Old turns | Client | Yes | **Adopt** as engine core |
| **Extractive retrieved-context compression** | Retrieved docs | Client | No (selection) | Prototype |
| **Small-encoder prompt compression** (perplexity/classifier token dropping) | Prompt tokens | Client, CPU-friendly | Yes (ungrammatical) | Prototype for **prose only** — risky on code |
| **Code-aware span pruning** | Candidate redundant code spans | Client | Yes | Untested hypothesis; no comparative evidence here establishes it as promising or safe |
| **Recursive/hierarchical summaries (RAPTOR-style tree)** | Corpus + long trajectories | Client (offline build) | Yes | Adopt for repo knowledge / long-horizon notes |
| **Soft-prompt / gist compression, xRAG** | Prompt → dense vectors | Server (needs model control) | Yes, extreme | **Avoid** — impossible via remote APIs |
| **KV-cache / attention compression** | KV tensors | Server (self-host only) | Yes | **Avoid** — no API surface |

Provider caching is provider-specific: some APIs expose prompt-cache usage/controls, others do not or report different accounting classes. Treat cache behavior as a negotiated adapter capability rather than a universal property or the only provider-side reuse mechanism.

The table's order is an implementation/evaluation order, not a claim of measured
effectiveness. The cited upstream RTK documentation describes its own byte-based
estimate and reduction claims; HorizonCode has no independent task-level evidence for
any relative compression ranking. Provider caching documentation describes route
semantics, not cross-provider comparative savings. No strategy is called “best” until
paired task evaluation measures verified success, cost basis, latency, retries, output
recall, and local resource use.

## 3. Extractive vs abstractive (code vs prose)

- **Extractive** (select spans verbatim) preserves identifiers, hashes, versions, exit codes, and line numbers. Whether it reduces cost or preserves task quality is an empirical question. **For code, extraction and grouping are safer than rewording; neither is automatically safe** — one omitted condition or log line can change a diagnosis.
- **Abstractive** (generate a summary) is shorter and more readable for **prose** (issues, plans, discussions) but hallucinates: it merges versions, invents paths, and drops negations. Use it only for prose, **constrained by a schema** (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).
- **Hierarchical**: parent summaries of child summaries, retrieved at the right altitude. Failure mode is error propagation — keep leaf recovery (full log in the store, original diff in VCS) and version summaries.

## 4. Chosen strategy (ordered)

1. **Provider-adapter-aware stable prefixes.** Keep HorizonCode's internal context projection deterministic, but let each adapter render the ordering and supported cache controls required by its wire API. Pin the exact serialized static prefix per context epoch; never claim a cache hit without provider usage evidence.
2. **Ranked repo map + JIT file access.** Do not load what you can select (`REQ-CTX-001`).
3. **Native deterministic observation formatters + full-output recall store**, per command family, **eval-gated** (`REQ-CTX-006`). This is the adopted "RTK" pattern.
4. **Keep-tail + structured-summary compaction, with tool-result clearing as the lightest first step** (`REQ-CTX-002`, `REQ-CTX-004`).
5. **Prototypes behind a flag**, enabled only after a code-quality eval passes: small-encoder prompt compression for prose; code-aware span pruning; extractive retrieved-context compression; hierarchical trajectory notes + subagent distillation.
6. **Avoid:** depending on the external filter binary; any server-plane KV/gist technique; abstractive summarization of diffs/logs/build output as a default; any "compress harder" knob without a paired task-success gate.

## 5. How compression is judged (no self-deception)

- **Paired per-task A/B** with a pre-registered sample size and endpoints. Three pairs are a smoke test only, not inferential evidence. Report all per-task observations, medians, pass-rate changes, uncertainty, resource use, and exclusions; do not present aggregate output-byte/token reduction as task-level cost savings.
- Suites: software-engineering task suites, terminal/agent benchmarks, and repo-continuity probes (can a post-compaction agent still recover decision X, file Y, error Z?).
- Operational metrics: cache-read %, turns-to-pass, summary-recovery hit rate, re-read rate.
- **Compressor-internal counters are not evidence** (`REQ-CTX-009`).

## 6. Requirements mapping

`REQ-CTX-002`, `REQ-CTX-003`, `REQ-CTX-004`, `REQ-CTX-006`, `REQ-CTX-007`, `REQ-CTX-008`, `REQ-CTX-009` (see `ARCH/02`).

## 7. Open questions

1. **Budget objective** — priority is verified multi-hour completion; cost, latency, and breadth are constrained outcomes measured alongside it. No universal “best compression” threshold is established yet.
2. **Local scorer allowed?** — whether a bundled small local model (for encoder-based pruning and extractive scoring) is acceptable, and its footprint budget.
3. **Authoritative eval suite** — which suites are the gate for compression changes, and the approved paired-A/B budget.
4. **Recall store lifecycle** — retention, size cap, and interaction with the audit log and session portability.
5. **Formatter coverage scope** — the initial allowlist of command families, and the process for adding one without a code change.
