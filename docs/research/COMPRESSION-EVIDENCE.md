# Compression evidence

## The named tool, identified

The user named **"RTK compression"**. The current upstream README describes an Apache-2.0 Rust command-output proxy that filters supported shell command results before they enter model context, with per-command transformations and optional hooks. It explicitly says its advertised reductions apply to command output and are not equivalent to invoice savings; its token estimate uses `bytes / 4` ([upstream README](https://github.com/rtk-ai/rtk)). This is the upstream's description, not an independent measurement.

The documented transform families include:

- **filtering** — keep the signal fields, drop boilerplate;
- **grouping** — collapse repeated findings by file/module;
- **truncation** — bound long lines and windows;
- **deduplication**.

Output recall and hook coverage are features described by upstream documentation; before any interoperability or implementation decision, verify current behavior against the pinned source and test it. Hooks may only rewrite the command the user/agent requested through an explicitly governed route: the wrapper must preserve argv boundaries, exit status, stderr/stdout semantics, cwd and environment, and must not bypass HorizonCode's guard, sandbox, or audit.

**Evidence limit.** This audit found no independently reproducible task-level benchmark sufficient to conclude that an output filter lowers cost per verified task. Do not repeat marketing reduction percentages as savings. Measure total input/output/cache tokens, task success, output recall, retries, latency, and invoice amount on the same tasks. A formatter is a lossy projection and must keep the exact full output retrievable; missing or expired source output makes a filtered result unsuitable as sole verification evidence.

**Conclusion — adopt a pattern for evaluation, not a dependency by default.** Prototype deterministic per-command formatters with a full-output recall store; do not shell out to an external binary from inside the trusted core. An optional external tool integration is separately permissioned and audited. Compaction, prompt caching, and output formatting affect different portions of cost and must be evaluated together and separately.

## The field, ranked by evidence strength

| Technique | Compresses | Runs | Lossy | Fit for a remote-API Rust CLI |
|---|---|---|---|---|
| **Prompt caching** (stable prefix, explicit breakpoint) | Repeated stable-prefix processing; billing/latency only where provider documents the effect | Provider adapter | No (exact reuse) | Implement only for documented route capabilities; comparative savings are unmeasured here |
| **Ranked repo map + just-in-time reads** | What is loaded at all | Client | Yes (omitted source spans remain retrievable) | **Adopt** — avoid loading, don't compress |
| **Deterministic observation formatters + recall** | Tool observations | Client | Yes, recoverable | **Adopt** (eval-gated per family) |
| **Keep-tail + structured-summary compaction + projection-only tool-result clearing** | Old turns | Client | Yes | **Adopt** as engine core, with the exact-result retention contract below |
| **Extractive retrieved-context compression** | Retrieved docs | Client | Yes (omitted source spans remain retrievable) | Prototype |
| **Small-encoder prompt compression** (perplexity/classifier token dropping) | Prompt tokens | Client, CPU-friendly | Yes (ungrammatical) | Prototype for **prose only** — risky on code |
| **Code-aware span pruning** | Candidate redundant code spans | Client | Yes | Untested hypothesis; no comparative evidence here establishes it as promising or safe |
| **Recursive/hierarchical summaries (RAPTOR-style tree)** | Corpus + long trajectories | Client (offline build) | Yes | Prototype only; quality, cost and freshness acceptance required |
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

Compaction trigger comparisons are recorded separately in
[`compaction-upstream-comparison.md`](../../research%20docs/compaction-upstream-comparison.md)
and source-pinned in [`docs/research/SOURCE-TRACEABILITY.md` U-CTX-COMPACTION](SOURCE-TRACEABILITY.md).
Grok Build's 85%, Codex's 90%-clamped per-model token threshold, and OpenCode's
buffer-based fit check are different policies; HorizonCode's 50% default is a product
decision (`DEC-006`), not an upstream consensus or measured optimum.

