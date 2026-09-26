# 19 — Context Compression: Evidence and Chosen Strategy

This document answers *"check, don't just implement"* for context compression. It records what was investigated, what the evidence actually shows, and the strategy the context engine (`CMP-context`, `ARCH/09`) must implement.

## 1. The named tool, identified

The user named **"RTK compression"**. Investigated and identified: it is a widely shared, Apache-2.0 **Rust CLI output-filter proxy** that rewrites common developer commands (VCS status/log/diff, `ls`/tree, file reads, search, test/build/lint runners, container and cloud CLIs) into a filtered form before execution. Its mechanism is four **deterministic, model-free** transforms per command family:

- **filtering** — keep the signal fields, drop boilerplate;
- **grouping** — collapse repeated findings by file/module;
- **truncation** — bound long lines and windows;
- **deduplication**.

Full output is retained in a local store and recoverable on demand (a `recall` command), and it emits self-reported "savings" analytics. Token accounting is a `bytes/4` estimate. It integrates via an editor/agent pre-tool hook that rewrites `command → rtk command`.

**This is a real, well-engineered pattern. It is not a cost panacea.** Two independent, later benchmarks (a paired IDE-vendor study and a Terminal-Bench run by an unrelated vendor) both found **no per-task cost reduction** — parity at the best-tested effort level and *increases* at another — with task quality statistically tied. Reasons identified by both:

1. Only a minority of input characters ever flow through the compressible channel; large input shares come from cached context re-reads and uncovered commands (editors' own file reads bypass the hook; piped/heredoc/interpreter invocations are excluded).
2. Cached re-reads are billed at a fraction of fresh input, so shrinking fresh output barely moves the bill.
3. The tool's self-reported "saved" counter compares against a counterfactual (whole-file) that the host truncates or caches anyway — **it overcounts**. One run reported hundreds of millions "saved" while the measured bill rose.

**Conclusion — adopt the pattern, not the dependency.** Reimplement deterministic per-command observation formatters natively in Rust with a full-output recall store; **do not** shell out to the external binary, and **never** present a compressor-internal counter as a saving. The pattern is complementary to compaction and caching, not a substitute.

## 2. The field, ranked by evidence strength

| Technique | Compresses | Runs | Lossy | Fit for a remote-API Rust CLI |
|---|---|---|---|---|
| **Prompt caching** (stable prefix, explicit breakpoint) | Billing/latency of a stable prefix | Provider (one flag) | No (exact reuse) | **Adopt first** — largest proven lever |
| **Ranked repo map + just-in-time reads** | What is loaded at all | Client | No (selection) | **Adopt** — avoid loading, don't compress |
| **Deterministic observation formatters + recall** | Tool observations | Client | Yes, recoverable | **Adopt** (eval-gated per family) |
| **Keep-tail + structured-summary compaction + tool-result clearing** | Old turns | Client | Yes | **Adopt** as engine core |
| **Extractive retrieved-context compression** | Retrieved docs | Client | No (selection) | Prototype |
| **Small-encoder prompt compression** (perplexity/classifier token dropping) | Prompt tokens | Client, CPU-friendly | Yes (ungrammatical) | Prototype for **prose only** — risky on code |
| **Code-aware span pruning** | Redundant code spans | Client | Yes | Prototype; most promising 2025–26 code-specific line |
| **Recursive/hierarchical summaries (RAPTOR-style tree)** | Corpus + long trajectories | Client (offline build) | Yes | Adopt for repo knowledge / long-horizon notes |
| **Soft-prompt / gist compression, xRAG** | Prompt → dense vectors | Server (needs model control) | Yes, extreme | **Avoid** — impossible via remote APIs |
| **KV-cache / attention compression** | KV tensors | Server (self-host only) | Yes | **Avoid** — no API surface |

The only provider-exposed form of server-side KV reuse is **prompt caching**, which is therefore the actionable part of that whole family.

## 3. Extractive vs abstractive (code vs prose)

- **Extractive** (select spans verbatim) preserves identifiers, hashes, versions, exit codes, and line numbers. It reaches very high reduction on retrieval tasks with minimal quality loss precisely because it does not paraphrase. **For code, extraction and grouping are safe; rewording is not** — one dropped token can be a compile error.
- **Abstractive** (generate a summary) is shorter and more readable for **prose** (issues, plans, discussions) but hallucinates: it merges versions, invents paths, and drops negations. Use it only for prose, **constrained by a schema** (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).
- **Hierarchical**: parent summaries of child summaries, retrieved at the right altitude. Failure mode is error propagation — keep leaf recovery (full log in the store, original diff in VCS) and version summaries.

## 4. Chosen strategy (ordered)

1. **Stable-prefix prompt caching.** Fixed order tools → system → messages; an explicit cache breakpoint at the end of static content; never mutate the cached prefix mid-run; track cache-read vs cache-creation tokens as the real metric.
2. **Ranked repo map + JIT file access.** Do not load what you can select (`REQ-CTX-001`).
3. **Native deterministic observation formatters + full-output recall store**, per command family, **eval-gated** (`REQ-CTX-006`). This is the adopted "RTK" pattern.
4. **Keep-tail + structured-summary compaction, with tool-result clearing as the lightest first step** (`REQ-CTX-002`, `REQ-CTX-004`).
5. **Prototypes behind a flag**, enabled only after a code-quality eval passes: small-encoder prompt compression for prose; code-aware span pruning; extractive retrieved-context compression; hierarchical trajectory notes + subagent distillation.
6. **Avoid:** depending on the external filter binary; any server-plane KV/gist technique; abstractive summarization of diffs/logs/build output as a default; any "compress harder" knob without a paired task-success gate.

## 5. How compression is judged (no self-deception)

- **Paired per-task A/B**, k ≥ 3, pre-registered endpoints; report the **paired per-task median delta and the pass-rate delta**, never totals (a single outlier flips totals — both cited benchmarks hit this).
- Suites: software-engineering task suites, terminal/agent benchmarks, and repo-continuity probes (can a post-compaction agent still recover decision X, file Y, error Z?).
- Operational metrics: cache-read %, turns-to-pass, summary-recovery hit rate, re-read rate.
- **Compressor-internal counters are not evidence** (`REQ-CTX-009`).

## 6. Requirements mapping

`REQ-CTX-002`, `REQ-CTX-003`, `REQ-CTX-004`, `REQ-CTX-006`, `REQ-CTX-007`, `REQ-CTX-008`, `REQ-CTX-009` (see `ARCH/02`).

## 7. Open questions

1. **Budget objective** — is the primary target lower cost per task, fewer turns, or longer-horizon continuity? They trade off (smaller turns × more turns can raise the bill). Needs an explicit priority for default routing.
2. **Local scorer allowed?** — whether a bundled small local model (for encoder-based pruning and extractive scoring) is acceptable, and its footprint budget.
3. **Authoritative eval suite** — which suites are the gate for compression changes, and the approved paired-A/B budget.
4. **Recall store lifecycle** — retention, size cap, and interaction with the audit log and session portability.
5. **Formatter coverage scope** — the initial allowlist of command families, and the process for adding one without a code change.
