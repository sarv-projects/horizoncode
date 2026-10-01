# Automatic compaction: upstream comparison

Reviewed 2026-09-30. This is a focused source comparison of compaction defaults and
trigger/recovery ownership, not a full repository audit. No source code, schemas,
tests, or assets were copied. Commit pins and exact files are repeated in
[`docs/research/SOURCE-TRACEABILITY.md` U-CTX-COMPACTION](../docs/research/SOURCE-TRACEABILITY.md#u-ctx-compaction).

## Findings

| Project | Observed behavior at the cited revision | HorizonCode disposition |
|---|---|---|
| Grok Build | The shared compaction config defines an 85% default, and the agent compaction policy also defaults to 85%. Trigger wiring is explicitly left to each host. The code comment says this is shared with Grok chat; this is a project-specific setting, not a general standard. | Pattern evidence only. HorizonCode keeps the user-selected 50% default and makes all automatic trigger paths share the same `compaction.auto` gate. |
| Codex | `ModelInfo::auto_compact_token_limit()` derives a threshold at 90% of its resolved context window if no explicit limit is set, and clamps an explicit per-model value to at most 90% when a window is known. This is a model-specific token-limit policy, not an identical fraction-trigger implementation. | Pattern evidence only. HorizonCode uses a configurable fraction against the selected route's resolved window and independently enforces a hard fit reserve. |
| OpenCode | The cited compaction implementation has `auto`, a 20,000-token buffer, and an 8,000-token keep tail. Its pre-send path estimates system/messages/tools against context minus the larger of output allowance and buffer, then invokes overflow compaction. | Pattern evidence only. HorizonCode separately specifies proactive threshold, pre-send hard fit, pre-content provider rejection, and in-generation remaining-context truncation. A single bounded recovery counter prevents multiple classes from compounding retries in one logical step. |

There is no universal upstream default. The values 85% (Grok), 90% (Codex), and
OpenCode's reserved-buffer calculation are not directly interchangeable: they measure
different trigger policies and reserve treatment. HorizonCode's 50% default is the
product choice recorded in `DEC-006`, not a claim that peers use it or that it is
empirically optimal. `AX-203` must evaluate the chosen threshold against task recall,
context-window boundaries, and cost/latency before any performance claim.

## Failure lessons

OpenCode issues #16882 (v1.2.24) and #30664 (v1.15.13) report automatic overflow
recovery paths that bypassed `compaction.auto=false`. They are historical issue
reports, not proof that the current pinned source has the same defect. They motivate
an explicit HorizonCode acceptance assertion: with `auto=false`, no pre-send trigger,
provider-rejection recovery, or remaining-context truncation recovery may compact or
retry; the independent hard fit guard still returns a typed error without dispatch.
Manual compaction remains available. A historical OpenCode issue #46164 also reports
that a manual compaction path could send a summary request without checking the
summary model's own context fit. HorizonCode's manual and automatic paths therefore
both need explicit input-fit validation and a visible failure when the summary request
cannot fit.

## Pinned primary sources

- Grok Build Apache-2.0, commit `37949780c144e37df692e3d669051a21fec24f20`:
  [`code_compaction/config.rs`](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/common/xai-grok-compaction/src/code_compaction/config.rs),
  [`xai-grok-agent/src/compaction.rs`](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-agent/src/compaction.rs).
- Codex Apache-2.0, commit `814de47b69dd63a2660fd14f9af66690888d183e`:
  [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/814de47b69dd63a2660fd14f9af66690888d183e/codex-rs/protocol/src/openai_models.rs),
  specifically `ModelInfo::auto_compact_token_limit()` and its field documentation.
- OpenCode MIT, commit `2fa3363c924c5c3e367b84a87ae478296a0ed59b`:
  [`core/src/session/compaction.ts`](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/core/src/session/compaction.ts),
  [`opencode/src/session/prompt.ts`](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/opencode/src/session/prompt.ts).
- OpenCode issue reports: [#16882](https://github.com/anomalyco/opencode/issues/16882),
  [#30664](https://github.com/anomalyco/opencode/issues/30664),
  [#46164](https://github.com/anomalyco/opencode/issues/46164). These are evidence
  of reported failure modes only; they are not normative implementation contracts.

## HorizonCode design owners

`DEC-006`, `REQ-CTX-002`, `REQ-CTX-004`, `REQ-CTX-011`, `ARCH/core/AGENT-LOOP.md`, `ARCH/core/CONTEXT.md`,
`ARCH/core/PROVIDERS.md`, and `ARCH/core/COMPRESSION.md` own behavior. `ACC-P1-07` and the tests listed in
`research docs/tests.md` own verification. `AX-203` owns implementation. No peer
threshold or implementation is copied.
