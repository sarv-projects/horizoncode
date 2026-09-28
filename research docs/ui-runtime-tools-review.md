# UI, runtime, tool, and context-optimization source review

Review date: 2026-09-28. Read-only, source-path-scoped review of UI/runtime/tool
subsystems in pinned checkouts. This is not a claim that every line of each large
repository was read. No source was copied and no peer tests or benchmarks were run.

## Pinned repositories

| Repository | Revision | License / use |
|---|---|---|
| [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman/tree/f8e9d7860ebbfcaf02ac0f3e66064a8822606f93) | `f8e9d7860ebbfcaf02ac0f3e66064a8822606f93` | GPL-3.0; pattern only |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands/tree/f174ba8465233e46e66ab2c5667b358f1d6676d6) | `f174ba8465233e46e66ab2c5667b358f1d6676d6` | MIT; current repo is Agent Canvas UI/control plane |
| [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk/tree/71612374a8d3c639909b03613dbecf1ff999d0bd) | `71612374a8d3c639909b03613dbecf1ff999d0bd` | MIT; separate runtime SDK |
| [hotovo/aider-desk](https://github.com/hotovo/aider-desk/tree/6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012) | `6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012` | Apache-2.0 |
| [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix/tree/562cdd3f7ec198aadf63e001e3c1132caf0f349b) | `562cdd3f7ec198aadf63e001e3c1132caf0f349b` | MIT |
| [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph/tree/6b12d11625cbec3b6773e076cb3d136464fa90e5) | `6b12d11625cbec3b6773e076cb3d136464fa90e5` | MIT |
| [oraios/serena](https://github.com/oraios/serena/tree/7a2968335f2198b966864de1ce3655c8e485a653) | `7a2968335f2198b966864de1ce3655c8e485a653` | GPL-3.0-or-later; pattern only |
| [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep/tree/3fce3b5bb0236da2df6d99672afb8a719642eca7) | `3fce3b5bb0236da2df6d99672afb8a719642eca7` | MIT or Unlicense |
| [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep/tree/25334496c105c9c728f0a6024f3d164aed40cacc) | `25334496c105c9c728f0a6024f3d164aed40cacc` | MIT |
| [astral-sh/ruff](https://github.com/astral-sh/ruff/tree/4b84fcf6b9a0158d1b17c06730d58590352b8869) | `4b84fcf6b9a0158d1b17c06730d58590352b8869` | MIT; Python-only tooling |
| [helix-editor/helix](https://github.com/helix-editor/helix/tree/079a789e8cb08ead67f19e1971a1b7438b37354b) | `079a789e8cb08ead67f19e1971a1b7438b37354b` | MPL-2.0; architecture study only |
| [gitui-org/gitui](https://github.com/gitui-org/gitui/tree/2fa693cb6ed431b21ebc300dd02e83c2476699ce) | `2fa693cb6ed431b21ebc300dd02e83c2476699ce` | MIT |
| [XAMPPRocky/tokei](https://github.com/XAMPPRocky/tokei/tree/c14f744716272fadeb27a74443cdffa0af35f82f) | `c14f744716272fadeb27a74443cdffa0af35f82f` | MIT or Apache-2.0 |
| [warpdotdev/warp](https://github.com/warpdotdev/warp/tree/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7) | `0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7` | AGPL-3.0; pattern only |
| [oh-my-pi](https://github.com/can1357/oh-my-pi/tree/6dad5de125c2a508983c0f3e7ef9e79205ab71df) | `6dad5de125c2a508983c0f3e7ef9e79205ab71df` | MIT |
| [Headroom](https://github.com/headroomlabs-ai/headroom/tree/f074711726ab7e02395463b095f121dd185aefd9) | `f074711726ab7e02395463b095f121dd185aefd9` | Apache-2.0 |
| [Lowfat](https://github.com/zdk/lowfat/tree/a17b3e0602c954a8160abc9086085083ad2405d5) | `a17b3e0602c954a8160abc9086085083ad2405d5` | Apache-2.0 at reviewed HEAD (`Cargo.toml` workspace and `LICENSE` agree); no code copied |
| [OMNI](https://github.com/fajarhide/omni/tree/2bf39744601a77d704794354ffa616eb463ac694) | `2bf39744601a77d704794354ffa616eb463ac694` | Apache-2.0 |

## OpenHuman and future web client boundary

The OpenHuman `src-tauri-web` description calls browser mode an E2E/future-compatible
shell over the existing Vite app and a standalone Rust core via HTTP JSON-RPC. This is
not evidence of a hardened multi-user production service. See [web shell README](https://github.com/tinyhumansai/openhuman/blob/f8e9d7860ebbfcaf02ac0f3e66064a8822606f93/app/src-tauri-web/README.md).

The UI tracks activity per `thread_id`, reports thread-creation failures and overlapping
requests, and projects subagent spawn/wait/completion, changed files, tokens, and cost
into chat state: [`threadSlice.ts`](https://github.com/tinyhumansai/openhuman/blob/f8e9d7860ebbfcaf02ac0f3e66064a8822606f93/app/src/store/threadSlice.ts),
[`ChatRuntimeProvider.tsx`](https://github.com/tinyhumansai/openhuman/blob/f8e9d7860ebbfcaf02ac0f3e66064a8822606f93/app/src/providers/ChatRuntimeProvider.tsx).
Live steering/abort handles are process-local; persisted child-task records reconcile
orphaned children as failed rather than falsely resumed: [`running_subagents.rs`](https://github.com/tinyhumansai/openhuman/blob/f8e9d7860ebbfcaf02ac0f3e66064a8822606f93/crates/openhuman-core/src/agent/orchestration/running_subagents.rs),
[`task_ledger.rs`](https://github.com/tinyhumansai/openhuman/blob/f8e9d7860ebbfcaf02ac0f3e66064a8822606f93/crates/openhuman-core/src/agent/orchestration/running_subagents/task_ledger.rs).

**HorizonCode:** the per-Thread UI state and explicit orphan reconciliation fit the
already proposed Thread/WorkerExecution and app-server boundary. The web shell suggests
a future client of the same control API, not bundling a web server into the local TUI
binary. GPL source is not copied.

## OpenHands is not one runtime

The checked OpenHands/OpenHands head is Agent Canvas (frontend/control plane); it
delegates runtime ownership to separate Software Agent SDK/Agent Server projects. Do
not attribute SDK runtime features to Canvas itself. The SDK event-sourcing benchmark
uses SWE-Bench traces to measure event indexing/replay/recovery latency, not code-task
success on SWE-Bench: [`bench_replay_and_recovery.py`](https://github.com/OpenHands/software-agent-sdk/blob/71612374a8d3c639909b03613dbecf1ff999d0bd/scripts/event_sourcing_benchmarks/bench_replay_and_recovery.py).

**HorizonCode:** benchmark infrastructure replay and coding-task success as different
metrics. The current [`research docs/tests.md`](tests.md) must never count event-store
throughput as SWE-Bench pass rate.

## AiderDesk: modular desktop ownership and persistence limits

AiderDesk keeps filesystem, subprocess, Git, and service ownership in the Electron main
process behind a typed preload boundary; it has data-driven `AgentProfile`s,
profile-backed subagents, and provider adapter registries. Its task history ADR warns
that JSON task files can be partial on interruption and does not claim crash safety
without atomic replacement/backup.

Evidence: [main/renderer architecture ADR](https://github.com/hotovo/aider-desk/blob/6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012/docs/adr/core-architecture/0001-electron-multi-process-model.md),
[agent profiles ADR](https://github.com/hotovo/aider-desk/blob/6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012/docs/adr/agent-system/0007-agent-profiles-and-system-prompts.md),
[provider registry ADR](https://github.com/hotovo/aider-desk/blob/6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012/docs/adr/model-integration/0013-provider-adapter-registry.md),
[task persistence ADR](https://github.com/hotovo/aider-desk/blob/6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012/docs/adr/task-and-project/0016-task-lifecycle-and-persistence.md),
[subagent runner](https://github.com/hotovo/aider-desk/blob/6c88d6dbef0e7b5a58da57a2c308a4c0be2c6012/src/main/agent/subagent.ts).

**HorizonCode:** reinforces one privileged service owner and declarative profiles, but
retain event-store transactions and crash-recovery requirements; do not copy its
per-file task persistence as a durability design.

## Provider-specific prefix caching

DeepSeek-Reasonix's Anthropic adapter removes Anthropic `cache_control` markers for
DeepSeek and tests that behavior. Its OpenAI-family adapter normalizes multiple vendor
usage shapes. Cache diagnostics hash system/tools/body and compare prefix changes; they
do not create a universal provider cache. See [`anthropic.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/562cdd3f7ec198aadf63e001e3c1132caf0f349b/internal/model/anthropic/anthropic.go),
[`anthropic_test.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/562cdd3f7ec198aadf63e001e3c1132caf0f349b/internal/model/anthropic/anthropic_test.go),
[`openai.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/562cdd3f7ec198aadf63e001e3c1132caf0f349b/internal/model/openai/openai.go),
[`cache_shape.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/562cdd3f7ec198aadf63e001e3c1132caf0f349b/internal/runtime/agent/cache_shape.go),
and [live cache probe](https://github.com/esengine/DeepSeek-Reasonix/blob/562cdd3f7ec198aadf63e001e3c1132caf0f349b/internal/model/openai/realcache_test.go).

**HorizonCode:** stable context prefix is a rendering optimization; cache write/read
controls and usage are adapter-specific. Preserve per-provider capability, request,
reported hit/miss, and billing facts; absent reporting is `unknown`. The same applies
to OpenCode's broad provider registry—never interpret a capability of one provider as
universal.

## Tools and repository intelligence candidates

- **Code Review Graph** builds a local SQLite source graph, incremental index, impact
  analysis and test-gap review. Its README says its reported recall is circular because
  ground truth comes from its own graph; do not cite that as independent accuracy.
  See [README](https://github.com/tirth8205/code-review-graph/blob/6b12d11625cbec3b6773e076cb3d136464fa90e5/README.md).
- **Serena** offers optional LSP symbol tools but is Python/GPL with language-server
  process and dependency costs. Prefer HorizonCode's lightweight search/Tree-sitter
  first and on-demand LSP processes; do not embed or link the GPL project.
- **ripgrep** is a practical optional/fallback subprocess for fast ignored-aware text
  search; bound results and run under workspace policy. See [README](https://github.com/BurntSushi/ripgrep/blob/3fce3b5bb0236da2df6d99672afb8a719642eca7/README.md).
- **ast-grep** adds structural Tree-sitter pattern search, complementary to literal
  search. Keep it an optional structural query path, not a new index owner. See
  [language crate](https://github.com/ast-grep/ast-grep/blob/25334496c105c9c728f0a6024f3d164aed40cacc/crates/language/src/lib.rs).
- **Ruff** applies to Python support scripts/fixtures, not Rust formatting. **Tokei**
  is repository-statistics only, never acceptance evidence. **Gitui** is a user-facing
  Git TUI, not agent runtime infrastructure. **Helix** is editor-state/LSP/view
  boundary research; MPL files are excluded from reuse.

## Tool-output reduction candidates

Headroom and Lowfat transform or compress tool output. They can reduce context usage,
but any lossy transformation risks omitting details needed for correct edits. Keep raw
output recoverable by bounded artifact reference; preserve errors verbatim; require
explicit transformed-output metadata; evaluate task correctness/regression alongside
token savings. Lowfat's reviewed root manifest and license agree on Apache-2.0; this
is a repository-level observation, not an audit of all transitive dependencies. OMNI's
hook pattern replaces repeated output with a retrieval handle and archives the source
locally, but only works where the host can rewrite tool output; MCP-only tools cannot
claim that benefit.

**HorizonCode:** treat all these as optional, benchmark-gated optimizations behind the
existing tool/context owners. Never let output filtering drop security-relevant logs,
test failures, or effect receipts. No universal savings estimate is established by this
review.

## Current implications

The existing architecture already names one control API (`ARCH/31`), provider-specific
protocol/cache capabilities (`ARCH/11`), thread-aware UI (`ARCH/06`), and bounded local
repository search (`ARCH/09`/`ARCH/21`). This review supports those seams, not additional
parallel owners. Add explicit acceptance for stale/unknown agent events, accurate UI
attribution, distinct infrastructure-vs-task-solving benchmarks, provider cache
dialect fixtures, raw-output recovery after optimization, and optional tool process
memory/latency/correctness measurements.
