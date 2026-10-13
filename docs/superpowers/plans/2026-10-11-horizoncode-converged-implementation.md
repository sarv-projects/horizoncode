# HorizonCode — current implementation checklist (2026-10-11)

Status: operative coding plan. Architecture authority is arch_V1/README.md + arch_V1/17-GOVERNANCE-DECISIONS.md. Current observed status is HANDOFF.md.

Do not use archived architecture or compatibility stubs as implementation instructions.

## Gate 0 — preserve and inspect

- [ ] Read AGENTS.md, HANDOFF.md, arch_V1/README.md, §17 and §10.
- [ ] Inspect git status/head and active processes; preserve user-owned dirty state.
- [ ] Inspect exact source/callers/tests for the first unfinished gate.
- [ ] If external code is needed, use §42 exact immutable source pin and complete license/dependency review.
- [ ] Run targeted baseline tests without interrupting unrelated active builds.

Exit: exact local implementation state known and no competing authority/runtime introduced.

## Gate 1 — P1.2-B Session observer production lifecycle

Owners/source to inspect first:
- packages/core/src/session/supervisor.ts and SessionV2/public Session flow;
- packages/server composition;
- kernel session projection/subscription/handshake/supervisor/startup code;
- existing Bun/Rust cross-runtime tests.

- [x] Automatic owner/lifecycle for relevant Session observer.
- [x] Stable SessionLink source ID/store/cursor/epoch/digest/redaction.
- [x] Authenticated/versioned private startup and READY gating.
- [x] Bounded pages, exact completed-page ACK, hasMore.
- [x] Retention gap -> resnapshot.
- [x] Restart from last completed cursor.
- [x] Active provider-turn crash/recovery test.
- [x] Cancellation/unsubscribe/host shutdown cleanup.
- [x] Rust cannot write canonical conversational content.
- [x] Platform support and unsupported reason are truthful.

Exit: read-only Session observation is production-shaped and restartable.

Verified implementation mapping (2026-10-11): OpenCode Session ID is the source owner ID; the injected `Database.Service.path` selects the exact EventV2 store; the durable per-Session cursor stores sequence plus event digest; the sidecar lease and authenticated handshake bind supervisor epoch and process incarnation; the Rust projection exposes only event/message/call IDs under its fixed redaction policy. On a retention gap, the host safely removes only owner-private derived projection/checkpoint files, then rebuilds from the unchanged OpenCode source. No separate transcript or Session message store is created.

## Gate 2 — P1.3 universal ToolBatch Guard/ExecutionHost

Inventory every effect entrypoint before coding:
- files/edit/shell/process/Git/build/test;
- legacy OpenCode routes;
- plugin/skill/hook/MCP;
- LSP mutation and DAP;
- browser/desktop;
- persistent REPL callbacks;
- settings/auth/network;
- hosted/provider-executed tools;
- external agents/automations.

- [ ] Pin turn provider/model/harness/tool registry/policy generation.
- [ ] Collect complete provider local-tool batch before any effect.
- [ ] Validate every call; malformed sibling denies whole effectful batch.
- [ ] Resolve canonical IDs/aliases and effect classes.
- [ ] Rust Guard admits/denies/needs approval for full batch.
- [ ] PREPARE durable EffectIntent and one-use leases before mutation.
- [ ] Execute effect only through authorized ExecutionHost/worker.
- [ ] Record receipt or UNKNOWN and reconcile target.
- [ ] Non-idempotent UNKNOWN is never blindly retried.
- [ ] Disable hosted effects that cannot be pre-authorized.
- [ ] Negative bypass tests for every included origin.
- [ ] Direct Session works without Goal.

Exit: no tested mutation path bypasses the canonical effect boundary.

Implementation increment (2026-10-11; Gate 2 remains open): the Core V2 SessionRunner admits a bounded single-call `files.write` through `effects.v2` and Rust Guard/EffectHost. Its turn digest binds `SessionRunnerLLM`, Session/agent/provider/model/variant, configured agent permissions, a stable `PermissionV2.policySnapshotDigest` (configured agent rules plus saved project grants), and pinned tool definitions. Effect-time PermissionV2 checks remain authoritative after explicit approvals. Core typecheck, 104 targeted Permission/runner tests, the recorded observer integration test, and the current live Runner→Rust integration test pass; the latter covers allowed single write and Rust denial of a two-write batch (1 test / 15 assertions), with replay denial and payload privacy checks. Other inventoried origins are not migrated; see `HANDOFF.md` for exact results. Do not mark Gate 2 complete.
Additional Core regression: supervisor/Rust effect-preparation failure denies the complete local batch before either an effectful write or read-only sibling settles (1 focused test / 5 assertions; Core typecheck passed).
- Additional Core V2 increment (2026-10-11): `ToolRegistry.materialize` in `packages/core/src/tool/registry.ts` omits registrations whose capability `effectClass` is unknown from both model definitions and the settlement snapshot. The regression checks missing and explicit unknown classifications are absent and return `Unknown tool` at validation/settlement without invoking them. Verification: `cd packages/core && bun test test/session-runner-tool-registry.test.ts` — 19 passed / 41 assertions; `bun test test/session-runner.test.ts` — 93 passed / 308 assertions; `bun run typecheck` passed. No live provider/platform was exercised; legacy/OpenCode and other external effect origins remain unmediated.
- Additional Core supervisor ownership guard (2026-10-11): `SessionSupervisor.watchSession` reserves a Session ID for one observer within its service instance, returns a typed ownership failure through the readiness Deferred on duplicates, and releases the reservation at scope exit. `SessionExecutionLocal` propagates the failure before `SessionRunner.run`; the live test verifies duplicate rejection and later sequential watcher recovery. Verification: `cd packages/core && bun test test/kernel-projection-live.test.ts -t "SessionRunner binds its generated digest through Rust effects.v2 and denies multi-write batches"` — 1 passed / 18 assertions using the local Rust sidecar; `bun test test/session-runner-recorded.test.ts` — 1 passed / 24 assertions; `bun run typecheck` passed. Observer duplication remains scoped to one Supervisor instance; Gate 2 remains open.
- Additional same-process V1/V2 ownership and preflight (2026-10-12; Gate 2 remains open): the module-level Session lease is keyed by Session ID and backend class (`core-v2` / `opencode-v1`), permits nested same-class scopes by refcount, and rejects cross-class overlap. Core V2 acquires before observer startup; V1 loop/shell, prompt/command, and summarize acquire before provider execution or their persistence/interpolation/compaction prework. The init handler preserves the typed busy failure; prompt_async preflights synchronously before forking, and the child repeats its lease. Public HTTP 409 is declared for init, prompt, prompt_async, command, and summarize. Verification: owner nesting 1 test / 3 assertions; V1 preflight 1 / 11; prompt conflict-before-persistence 1 / 3; command conflict-before-shell-interpolation 1 / 3; cassette provider + Linux Rust observer cross-flow 1 / 28; OpenAPI 409 1 / 9; HTTP mapper 1 / 2; summarize HTTP 409/prework 1 / 3; init + async prompt HTTP 409/prework 1 / 5. Those historical bounded typecheck attempts timed out without diagnostics; current follow-up package typechecks for Core and packages/opencode now pass independently. No live provider inference.
- Current V1 increment (2026-10-12; Gate 2 remains open): `Tool.Def` now carries canonical capability metadata through `ToolRegistry.tools`; `SessionTools.resolve` only exposes classified read-only builtins, the supported `files.write`, and internal control tools. The pinned `ai@6.0.168` V3 `wrapStream` gate buffers tool calls to terminal `tool-calls`, validates the complete batch, and asks the session-owned Rust supervisor to prepare non-read-only batches before callbacks. Missing/unknown/malformed/duplicate/mixed/unowned/cancelled/incomplete batches fail closed. A single admitted `files.write` passes its challenge into the existing PermissionV1 edit approval, then Rust `approveEffect`/`executeWrite`; local direct write was removed. Verification: tool batch 8 passed / 28 assertions; prompt capability + Rust-owner-unavailable integration 2 passed / 4 assertions; missing-challenge write regression 1 passed / 3 assertions. The denial path uses fake/unavailable-supervisor coverage, and the positive V1 write now also passes through the actual local Rust supervisor with approval/execution/receipt assertions. Both modified TypeScript packages pass independently. Other direct shell/subtask/command/plugin/MCP/LSP/HTTP origins remain outside this slice; provider-executed tools are only rejected on returned chunks and cannot be reversed after remote execution. Do not report P1.3/Gate 2 complete. Next: migrate or disable every remaining inventoried effect origin with negative/recovery coverage.

## Gate 3 — P2 managed control

Read §11/§12/§15 and existing kernel OwnerLog code.

- [ ] Goal + immutable accepted SpecVersion.
- [ ] Run/Task/Attempt state with versioning/idempotency.
- [ ] SessionLink correlation only; no Rust transcript.
- [ ] pause/resume/cancel fences.
- [ ] workspace/resource leases.
- [ ] evidence/verification bound to final integrated revision.
- [ ] restart/replay.
- [ ] retry exhaustion/NeedsYou.
- [ ] direct Session unaffected.

Exit: durable managed work is additive to OpenCode conversation ownership.

## Gate 4 — P3 coding path and RepoIntel

- [ ] canonical files/search/Git/terminal/build/test wrappers;
- [ ] stale-safe files.patch, optionally Hashline strategy internally;
- [ ] RepoIntel symbol/definition/reference path before broad reads;
- [ ] persistent index invalidation/overlay tests;
- [ ] bounded log/artifact search;
- [ ] context/tool discovery for small models;
- [ ] benchmark any native OMP-inspired walker/AST optimization before adoption.

Exit: common coding change is fast, source-grounded and Guarded.

## Gate 5 — P4 LSP, DAP and persistent REPL

Use §30, §37 and §33.

- [ ] reuse healthy editor LSP where possible;
- [ ] supervised LSP fallback and generation/stale edit behavior;
- [ ] code actions/rename through canonical file effect;
- [ ] debug.* adapter lifecycle, breakpoints/step/variables;
- [ ] guarded debug.evaluate with disable policy;
- [ ] repl.* bounded Python/JavaScript lifecycle;
- [ ] state persists only inside a REPL generation;
- [ ] tool callback re-enters ActionDescriptor/Guard;
- [ ] crash/reset/idle-expiry invalidates refs.

Exit: no language/debug/REPL route has ambient host authority.

## Gate 6 — P5 browser, desktop and built-in web search

- [ ] browser managed vs attached context ownership;
- [ ] generation-bound DOM/ARIA/screenshot refs;
- [ ] guarded navigation/click/type/upload/download;
- [ ] desktop displays/windows/AX/screenshot capability matrix;
- [ ] guarded focus/input/clipboard, DPI/geometry correctness;
- [ ] web.search direct vs grounded provider routes;
- [ ] provider/auth/cost/freshness provenance;
- [ ] no hidden paid fallback;
- [ ] worker/back-end crash and stale-ref tests;
- [ ] real supported-OS/provider journeys.

Exit: privileged interaction is mediated and support status truthful.

## Gate 7 — P6 agents/extensions/provider/model/settings UX

Use §16, §29, §33.

- [ ] AgentProfile/Harness registry and bounded specialists.
- [ ] Skill/Hook/MCP/plugin sealed IDs and trust/capability boundaries.
- [ ] one ActionDescriptor for slash/menu/key/API/model.
- [ ] agent/harness picker constrains model picker correctly.
- [ ] provider/model/role hub with cost/auth/status provenance.
- [ ] schema-driven settings requested/effective/source/locked/apply boundary.
- [ ] Goal draft/review/accept UI before managed effects.
- [ ] TUI/desktop underlying action/state parity.
- [ ] credentials never leak.

## Gate 8 — P7 streaming/artifacts/analytics/automation

Use §31/§37.

- [ ] bounded UiEventMux and stable streaming prefix/tail;
- [ ] transcript virtualization/focus/scroll stability;
- [ ] isolated safe SVG;
- [ ] closed-fence Mermaid;
- [ ] deterministic complete-table chart;
- [ ] terminal graphics negotiation/budget/fallback;
- [ ] SourceArtifact FULL/SAMPLE/FAILED truth;
- [ ] analytics measured/estimated/unknown provenance;
- [ ] automation durable overlap/missed/retry policy and Guarded invocation.

## Gate 9 — P8 long-horizon/recovery/evaluation

- [ ] bounded worktree/resource pool;
- [ ] deterministic recovery across host/kernel/worker/provider failure;
- [ ] stop criteria avoid quota waste;
- [ ] §32 real-work suites across model classes;
- [ ] security bypass suite;
- [ ] performance budgets;
- [ ] final integrated revision verification.

## Gate 10 — P9 packaging/release

- [ ] license/notices closure;
- [ ] native platform support matrix;
- [ ] signing/update/rollback if enabled;
- [ ] config/data migration;
- [ ] clean-install/upgrade;
- [ ] release UX/security/performance gates.

## Implementation evidence rule

A checkbox is not complete because docs/schema/unit mocks exist.

For every completed slice record:
- exact modified source/functions;
- owner/capability IDs;
- tests and outputs;
- negative/recovery case;
- platform/provider/backend actually exercised;
- performance/resource evidence when relevant;
- unsupported paths;
- resulting HANDOFF status.

No commit/push/destructive cleanup without explicit authorization.

## Current evidence checkpoint — 2026-10-12

- P1.2-B is complete for the currently claimed local lifecycle scope; P1.3 remains the active implementation gate.
- Core and `packages/opencode` pass isolated TypeScript checks with zero diagnostics.
- Focused HorizonCode push gate passes and builds the Rust supervisor before testing.
- Actual V1 `files.write` passes Rust admission -> approval -> execution -> receipt; denial, missing-challenge and complete-batch tests pass.
- Snapshot/root overlay audit compares 6,627 pinned files; 61 changed overlay files are Git-visible and enforced by `audit_overlay_visibility.py`.
- Fresh-clone hydration was tested: 5,762 missing root files restored without overwriting tracked README; second check found zero missing.
- Architecture convergence and provenance validators pass.
- Full 36-package Turbo typecheck PASSED locally on 2026-10-12: 30 executed/30 passed, 0 cached, exit 0. Full integrated release/CI validation is still open.
- OMP transport/catalog migration, native OpenCode adapter, visual edit and deployment flows are DESIGNED, not production-wired.
- P1.3 still requires shell/process/Task, plugin/hook/MCP, LSP/DAP, browser/desktop/REPL, settings/auth/network, hosted tools, automations and external-agent mutation coverage.
- Exact current commands/results live in `HANDOFF.md`; historical implementation increments above remain provenance, not the current status authority.

## Final adoption and execution reconciliation — 2026-10-14

**Status: approved implementation guidance, NOT implemented functionality.** Retain the complete V1 capability roadmap above and the canonical owners in §17/§20. Do not build another direct Session, agent loop, independent Rust tool authority, extension registry, native shell, leader daemon, or Rust TUI. The existing OpenCode-derived direct Session is canonical; Rust owns managed work, Guard, leases and effect evidence. This section chooses *order and implementation technique*, not a new architecture authority.

### Source-grounded adoption decisions

| Candidate | Decision | Proof before enabling |
|---|---|---|
| Grok early connection/prewarm, deferred auth/MCP discovery | Prototype behind existing selected provider/session transport; never make background paid calls | Cold/warm time to usable composer, first useful output, auth and MCP phase p50/p95 |
| Grok leader/follower IPC | Reuse current Horizon supervisor/session lifecycle; no new resident daemon by default | Owner exclusivity, reconnect, actual latency improvement |
| Grok CoW/Btrfs worktrees and gix status | Optional backends in existing leased workspace/search interfaces | Git/index correctness, dirty user-file preservation, disk pressure, cross-OS fallback, end-to-end time |
| Grok adversarial goal verifier | Optional independent read-only reviewer for complex managed tasks; deterministic evidence first | Criteria/revision-bound verdict; finite review/retry budget; no invented new requirements |
| OMP Hashline | Model-compatible edit dialect **inside existing files.patch**, not a security mechanism | Full source revision/digest/fence stale check; atomic failure; first-attempt success, tokens and retries |
| OMP artifact references and Agent Hub | Reuse existing artifact, Session and managed Task/Attempt identities for derived inspection, steering and bounded result refs | No second transcript or effect authority; permission and resume tests |
| Codex sandbox/checkpoint patterns | Implement accepted per-OS confinement and producer/route-compatible compaction metadata | Negative sandbox cases; newest invalid checkpoint must not silently fall back to older authority |
| OpenCode compaction, TUI, skills, hooks, ACP/MCP | Reuse pinned inherited implementation where tests prove support | V1/V2 parity, versioned toolset, no privilege bypass or redundant runtime |
| Snapcompact, default best-of-N, always-on classifier, full native shell, competing marketplace | DEFER as default; research only if later benchmark/product decision supports them | Explicit cost/privacy/accuracy tests and source license review |

### Security-critical native read/grep/gix acceptance

Do **not** paste the proposed `canonicalize() -> search_path()` Rust implementation into production. Validation followed by a path-based open is subject to symlink/TOCTOU races. A native backend must use a pinned root and audited handle-relative open-time confinement (for example Linux `openat2` where supported), consistent permission/redaction checks for every descendant and symlink, and the incumbent isolated backend or typed UNAVAILABLE when equivalent protection cannot be enforced. Read-only still can exfiltrate secrets to model/provider/logs. Bound bytes scanned/output, files/matches/line lengths, time, memory and workers. Propagate partial search/Git errors and filtered untracked status rather than falsely returning complete/clean. Blocking tasks retain cancellation ownership and semaphore limits until actually ended. Test hostile Git config, symlink swapping, protected files, cancellation and per-OS isolation.

Short Hashline display anchors (including 2-byte line hashes) never authorize edits. A source revision/full digest plus current Guard/lease is the authoritative precondition. Prepare and validate before atomic mutation and reject stale inputs; do not universally require read-before-write in the current context, which would unnecessarily block legitimate new-file creation.

### Real implementation dependency order

- [ ] **P1.3:** Inventory all V1/V2/legacy shell, command, plugin, hook, MCP, child, hosted, network and other mutation origins. Either mediate before dispatch through one Guard/ExecutionHost or disable, including provider-side tools without enforceable pre-execution authorization.
- [ ] **P1.3:** Enforce bounded ToolBatch count/argument size/stream time/memory; deny malformed/unknown/stale/cancelled effectful batches atomically; one-use lease, durable receipt, UNKNOWN reconciliation, true cancellation state and bypass tests.
- [ ] **Direct coding:** Execute an actual read/search/edit/test/diff/retry task without managed Goal overhead, with real evidence of the requested outcome and baseline latency/cost.
- [ ] **P2 managed vertical slice:** Accepted immutable SpecVersion -> Task/Attempt -> supervised bounded action -> effect receipt -> independently verified final integrated revision; crash/restart and human-edit conflict test before multiple workers.
- [ ] **Context/edit:** Preserve original direct history; rebuild compact control footer from canonical Rust task/effect state; pin checkpoint producer/model/harness/source cursor; reject malformed newest checkpoint rather than trusting older grant. Benchmark trim/compact retention, re-fetch, latency and outcome.
- [ ] **Speed:** Benchmark existing ripgrep/Git/index and patch paths first. Enable guarded native search/gix, Hashline, connection warming or CoW only behind rollback flags once both correctness/security and net benefit are proven.
- [ ] **V1 remaining gates:** Continue LSP, DAP, persistent REPL, browser, desktop, web-search, skills/hooks/plugin distribution, ACP/MCP integration, artifacts, rendering, UX and automation within their already approved owners, independently tested and accurately labeled.

### Six benchmark lanes, not another dashboard

Store small versioned JSON/CI artifacts bound to commit, OS, CPU/RAM, fixture, provider/model/harness, permission mode and cache state. Measure (1) cold/warm composer-ready, TTFT and first useful output with stage breakdown; (2) first *correct* repository search hit, incremental edit/rename/branch-switch update and stale window; (3) context/tool bytes, tokens, protected-fact retention, compaction latency and subsequent re-fetch; (4) first-edit success, stale conflict, retry count, final regressions and token cost by dialect; (5) 1/2/4/8 worker final verified success, wall time, conflicts, coordination, disk and cost; (6) TUI input/frame p95, scroll/focus, recomposition/CPU/memory at 100/1K/10K transcript blocks and parallel streams. Distinguish harness time, provider inference and **total verified task time**. Tool-ready ≠ feature WIRED; passing mocks ≠ end-to-end VERIFIED; existing GitHub workflow YAML ≠ green CI run.

### Evidence and source-truth rules

The remote source reviewed was `dead4339cae87f9e48c25e4e9586096d600bb164`; it has `kernel/`, `packages/core/`, `packages/opencode/` and `indexd/`, **not** the independent `horizoncode-runner`, `horizoncode-orchestrator`, `horizoncode-tools` or `horizoncode-tui` crates imagined in other reports. The key-shaped string in `opencode/packages/http-recorder/test/record-replay.test.ts` is inside a secret-detection fixture, not proof of a live credential. Do not rewrite Git history without actual alert and provenance confirmation. On review date, GitHub Actions had zero runs; no live CI/benchmark or runtime integration was verified by this documentation change. Use immutable source pins in §42 before translating rival code. The current implementation gate remains P1.3.

## Optional-feature Settings and Experimental class — A-V2-29

Integrate with the existing §16 Settings/config owner and §33 canonical capability/action registry; do not create a separate feature registry, feature daemon or TUI-only flags. `FeatureExposureV1` is a derived projection schema in `contracts-v2/feature-exposure-v1.schema.json`. The official maturity/release tag is `experimental` (then `beta`, `stable`), distinct from DESIGNED/CODE_PRESENT/WIRED/TESTED/VERIFIED/RELEASED and runtime unavailable/disabled reasons.

- [ ] At every optional feature introduction, register one searchable owning setting with stable key, default/scope, requested/effective/source/locked/apply-boundary and availability; display in Settings → Features, plus Settings → Experimental if classed experimental.
- [ ] Experimental default OFF; user explicitly opts in on eligible developer/early-access build. A DESIGNED/unsupported feature is disabled/unavailable, **never fake-enabled**. A developer-only feature is invisible as an actionable control in ordinary public builds.
- [ ] TUI command palette, help, tool/agent picker, running status and eventual desktop/web/API render `[Experimental]` or accessible equivalent from the **same descriptor**, and show effective status/reason. No TUI-only independent source of flags.
- [ ] Enabling a setting cannot override Guard/policy, change selected model/harness, launch paid inference, or perform an unauthorized effect. Apply boundary and next-turn/next-session/restart state are explicit.
- [ ] Run FEAT-001..010 in §32 with schema/registry validation before declaring a feature TESTED or VERIFIED; preserve safe disable/migration when class changes.

Examples that remain experimental/disabled until their runtime and benchmarks actually qualify: alternate native grep/gix backend, Hashline edit dialect, provider transport prewarm and CoW worktree backend. Deferred features (such as snapcompact) must not be mislabeled as operational merely by appearing under an Experimental heading.
