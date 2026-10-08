# 8. Reconciliation rationale and historical references

## 8.1 Historical provenance and source pins

`info.txt`, `info2.txt`, previous HorizonCode `ARCH/`, and research/conversation
material were consulted while authoring this architecture. They are historical
provenance only, not required inputs or implementation authorities. Their accepted
requirements and decisions are reconciled in this package. After freeze, new work must
use `arch_V1/` and inspect the exact source revisions listed below; it must not ask a
historical proposal or old architecture document to resolve an implementation question.
The old HorizonCode repository was initially preserved at the branch/tag specified in
§17. On 2026-10-08, the user directed removal of all prior Git metadata before a fresh
repository was initialized; those local refs and objects are now gone. The P0 archive
gate remains incomplete, and source must be independently recovered before assessing
any explicitly mapped component for selective porting.

- `info2.txt` cites [HorizonCode `cbbe27b…`](https://github.com/sarv-projects/horizoncode/tree/cbbe27b88b1ba869383093e262b4a6115533d615) and [OpenCode `5d9cd9b…`](https://github.com/anomalyco/opencode/tree/5d9cd9b259f0456522f318a7435501d03cfbee79). The initial
  architecture review began at HorizonCode `9fd96b07a65b3c2faf3380c4fd24069cc993598a`;
  event-log/sandbox source observations are tied to HorizonCode
  `5c20a65ee6c05c7771fbcbe1e2cde8fc192b8a34`. The selected OpenCode starting revision is
  `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`. The DeepSeek Harness reference is pinned
  at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. Older proposal source claims are not
  implementation evidence; revalidate against the selected current pin.

## 8.2 Reconciled decisions for adopted v1

| Topic | Adopted v1 decision | Reason / source status |
|---|---|---|
| Product/repository base | Target: new main starts directly from the exact pinned OpenCode commit; preserve prior HorizonCode as a legacy branch/tag and port components only against final owners | Original adopted direction; the later fresh-Git reset removed the local archive and the empty new main is not based on the OpenCode commit, so P0 remains incomplete |
| UI | OpenTUI + Solid TUI and OpenCode Solid/web/desktop surfaces | Adopted surface for the selected base; historical Ratatui alternative is superseded |
| Durable Thread | Rust Horizon kernel owns canonical Thread event streams and direct conversation history | Prevents OpenCode Session DB and Horizon Thread log becoming two writable truths; requires migration/adaptation |
| Provider/runtime | Core V2 (`packages/core`) is the sole production turn runner and uses `packages/llm` for provider protocols | Pinned source has separate Core V2 and legacy paths; converge production routes only after the canonical Thread and guarded tool/effect seams are ready |
| ExecutionHost | Rust module inside `hz-kernel`, between EffectService/Guard and the OS sandbox/process backend | It is not the Bun `hzcode` host or a separate process; it is the single Rust operation/process execution seam |
| ToolBatch owner | ThreadService owns all ToolBatch lifecycle transitions and ordered result links in the Thread stream | ToolExecutionCoordinator executes admitted calls and returns observations only; no second ToolBatch event store |
| Usage and budgets | UsageService owns append-only observations; BudgetService owns limits, reservations and accounting settlement; Analytics is derived | Keeps measurement provenance distinct from policy/control and projection |
| Provider-hosted execution | Disabled in guarded v1 unless it can be authorized before provider execution | Current `providerExecuted` path explicitly bypasses local dispatch; a post-fact Guard hook cannot mediate it |
| Tool batches | Collect full response, validate all calls and bounds, then admit batch before any execution | Current Core V2 dispatches local tools during stream consumption; this is a required integration adaptation, not existing parity |
| Kernel boundary | Rust process over private versioned IPC; no Rust FFI into Bun and no public kernel listener | Crash/store/authority separation; exact protocol and platform enforcement remain to be implemented and tested |
| Composition | Effect-based service definitions and plugin resolver, with generation pinning and drain | One service/provider/consumer model without a second effect framework |
| Canonical authority services | Thread, RunController, Supervisor, Usage, Budget, Guard, Effects, Audit, Workspace, Verification, Artifacts, Secrets, Composition and Kernel transport are sealed in production | Plugin composition is not authority replacement; test doubles only in test configuration |
| Third-party executable extensions | Isolated/capability-limited worker, not unrestricted host JS | OpenCode hooks can affect sensitive runtime surfaces; compatibility mode maps only supported hooks |
| Agent profiles | One registry for main/default/specialist/custom/native/external profiles | Revision-pinned profiles; no parallel catalogs |
| Model selection | Explicit/profile/inheritance precedence; price is accounting/budget only | No silent price, latency or reasoning downgrade; explicit fallback only under safe retry rules |
| Direct vs managed | Direct Thread turns remain light; managed Runs add Goal/Spec/DAG/Attempt/verification | Avoids forcing long-horizon machinery on routine pair coding |
| Completion truth | Only current independent Evidence can produce Task PASS/Run completion | Session idle, process exit, successful command and worker message are observations only |
| Repository intelligence and memory | Horizon-owned derived/advisory services, separate from Guard and canonical specs | Keeps index/memory provenance and freshness explicit |
| External agents | Supported through adapters with honest configured/observed/enforced truth | Outer workspace containment does not prove internal tool mediation |
| Remote/hosted features | Optional, feature-detected; not a local v1 prerequisite | Hosted availability cannot be inferred from local source |

## 8.3 Pinned-source corrections and required adaptations

The checked-out source has overlapping execution paths and must not be summarized as a
single already-integrated runtime:

- Core V2 `Session.prompt` durably admits input before its advisory wake, but
  `SessionRunCoordinator` and local drains are process-local. This provides useful
  input semantics, not durable worker/provider continuation after process death.
- Core V2 `runner/llm.ts` consumes `llm.stream(request)` and settles a local tool call
  as the `tool-call` event arrives; `providerExecuted` calls are skipped by the local
   settlement path. That differs from the adopted whole-response admission and
   kernel-before-execution invariant. The v1 integration must collect, validate, authorize and
  admit before dispatch; it must reject provider-hosted calls in governed mode.
- Legacy `packages/opencode/src/session/llm.ts` uses AI SDK `streamText` by default;
  `@opencode-ai/llm` native execution is behind an experimental flag with fallback.
  The Core V2 runner imports `@opencode-ai/llm`. The adopted architecture selects Core
  V2 as the sole production runner; product routes must converge on it, with the legacy
  path restricted to migration/compatibility.
- `packages/tui` depends on OpenTUI/Solid and also Core, Plugin, SDK and UI. It is an
  application package, not a renderer-only drop-in.
- Existing OpenCode permission prompts and process-local decisions do not establish
  OS sandboxing. Each tool family needs an inspected execution route into Horizon's
  effect owner or an explicit `unmediated/unsupported` status.
- `@opencode-ai/llm` includes provider-executed tool semantics. They are a deliberate
  governed-mode compatibility gap, not a reason to weaken Guard.

These statements are bounded source findings documented with paths/ranges in
[`09-SOURCE-MAP.md`](09-SOURCE-MAP.md). No tests/builds were run for this architecture
task; no finding here is an acceptance result.

The source-map section for old HorizonCode records historical implementation evidence
at its pinned legacy revision. Those paths are absent from new OpenCode-based `main`
unless a specific component is deliberately ported; their presence in the evidence ledger
does not authorize importing a crate or restoring its old architecture.

## 8.4 How the composition reference is adapted

The pinned [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) describes an all-plugin Cordis tree where model adapter, tool registry, persistence and agent loop are plugin-composed and configuration can replace providers. Its [architecture guide](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md#cordis) and [capability-seam definition](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md#capability-seams) inform the complete Service Definition / Service Provider / Consumer model and reversible contribution lifecycles.

Horizon v1 does not copy Cordis or make canonical authority replaceable by project plugins. Thread, RunController, Guard, Effects, Audit, Workspace and Verification remain sealed production providers. Service composition is an implementation seam; canonical fact ownership and security authority remain fixed. The [plugin manager reference](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/README.md#use-this-package) documents installed Host code executing in-process outside the workspace sandbox; v1 instead isolates/capability-limits third-party executable extensions.

The source guide's current-consumer rule is adopted: each Service Definition is designed against all consumers, consumer-specific schemas/UI/transport stay with their owners, and public operations require evidence of a current consumer. Authorization is enforced in the executor that performs the effect, not only in UI filtering or a facade. State is published only after the owning operation commits; complete outputs are bounded after serialization and metadata are included.

## 8.5 Capability-specific implementation gates

An unresolved decision is not a global implementation stop. Follow the **Must resolve
before** capability mapping in [`17-GOVERNANCE-DECISIONS.md`](17-GOVERNANCE-DECISIONS.md).
DEC-V1-10's repository cutover policy is adopted: P0 establishes the new OpenCode-based
main after preserving the old repository. Production route convergence remains later,
after canonical Thread/tool adaptation. Windows sandbox and provider-secret decisions gate their applicable production capabilities;
managed approval, Windows `run_durable`, and verifier-independence decisions gate P6/P7
capabilities; plugin/WASM/MCP/installer decisions gate their P8 ecosystem surfaces;
update signing gates P9 automatic updates. macOS/Linux support, retention policy,
redistribution, and remote continuation gate only their corresponding release or
product claims. Safe interim behavior stays in force, and unrelated work proceeds only
when its own dependencies and security boundaries are met.

The selected Core V2 runtime and one-to-one legacy Session alias/import contract are
defined in [`01-SYSTEM.md`](01-SYSTEM.md), [`02-DOMAIN.md`](02-DOMAIN.md), and
[`03-FLOWS.md`](03-FLOWS.md). The full decision register, including Windows sandbox
and `run_durable` blockers, secret delivery, extension trust, retention, update and
remote-work choices, is in [`17-GOVERNANCE-DECISIONS.md`](17-GOVERNANCE-DECISIONS.md).
Physical persistence mapping is in [`04-STATE-EVENTS.md`](04-STATE-EVENTS.md) and
current local source evidence in [`09-SOURCE-MAP.md`](09-SOURCE-MAP.md). Exact
migration code and acceptance fixtures remain implementation work, not an
unresolved ownership decision.

In particular, current local source has no confined Windows sandbox backend and the
existing event-log standard sink does not provide Windows `run_durable`. The adopted
architecture remains normative while those specific capabilities stay unavailable
until their contracts are resolved, implemented, and accepted. This document promotes
no source or acceptance status.

## Referenced upstream repositories

- [OpenCode — selected base repository at `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322)
- [OpenCode — older revision cited by `info2.txt`](https://github.com/anomalyco/opencode/tree/5d9cd9b259f0456522f318a7435501d03cfbee79)
- [DeepSeek Harness — cited/local composition reference pin](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)
