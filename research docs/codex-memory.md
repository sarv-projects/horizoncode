# Codex memory pipeline source review

**Pinned source:** `openai/codex` commit
[`33a0f766a647208b471cfbcad889c67fd324ee04`](https://github.com/openai/codex/tree/33a0f766a647208b471cfbcad889c67fd324ee04), checked 2026-09-28. Scope was the memory subsystem and its settings, not a full Codex audit. No code, prompt text, schema, or tests were copied.

## Files inspected

- [`codex-rs/memories/README.md`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/memories/README.md) — phases, stores, locking, bounded selection.
- [`codex-rs/memories/write/src/start.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/memories/write/src/start.rs), [`phase2.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/memories/write/src/phase2.rs), [`workspace.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/memories/write/src/workspace.rs), [`storage.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/memories/write/src/storage.rs) — orchestration, leases, filesystem baseline, and persistence.
- [`codex-rs/state/src/runtime/memories.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/state/src/runtime/memories.rs) and [`codex-rs/state/src/model/memories.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/state/src/model/memories.rs) — job/record state.
- [`codex-rs/memories/write/templates/memories/consolidation.md`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/memories/write/templates/memories/consolidation.md), [`codex-rs/ext/memories/templates/memories/read_path.md`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/ext/memories/templates/memories/read_path.md) — consolidation and retrieval guidance.
- [`codex-rs/config/src/types.rs`](https://github.com/openai/codex/blob/33a0f766a647208b471cfbcad889c67fd324ee04/codex-rs/config/src/types.rs) — controls, bounds, and defaults.

## Observed design

Codex separates bounded per-rollout extraction from serialized global consolidation. Extraction jobs are claimed/leased, selected within age and startup limits, run with bounded concurrency, and use retry backoff. Consolidation takes one global lease, selects bounded outputs using freshness/usage rules, writes a local git-baselined memory workspace, and asks a dedicated agent to consolidate when that workspace changed. The read path encourages a small searchable summary/index and progressive retrieval instead of injecting every memory. Config independently controls generation/use and bounds; this pinned revision defaults both memory generation and use to enabled, which is Codex's product choice, not HorizonCode's default.

The practical ideas HorizonCode should evaluate are: candidate extraction distinct from acceptance, bounded background jobs, durable leases/heartbeats, retry backoff, one serialized consolidation writer, a diff against the last accepted baseline, explicit pruning, and compact navigational retrieval. These are patterns, not evidence that generated memory is always accurate or beneficial.

## HorizonCode disposition and trade-offs

`DEC-067` deliberately chooses stricter consent: only explicit `/memory remember` candidates by default; extraction off; acceptance always explicit; user preferences separated from repository-scoped facts; cross-project retrieval off. If opt-in extraction is later added, reuse the *shape* of bounded leased jobs and staged review, but do not run background model calls until a user enables and configures their cost/privacy budget. Memory must stay out of policy and task-verification evidence. The canonical HorizonCode store remains SQLite with rebuildable indexes; a Git-like change record can support inspection, but duplicating canonical memory into another independently authoritative repository is not required.

No claim is made that this design equals Codex memory quality. Compare repeated repository tasks against a no-memory baseline and report stale retrieval, intent alignment, token cost, and human correction rate (`AX-371`; `research docs/tests.md`).
