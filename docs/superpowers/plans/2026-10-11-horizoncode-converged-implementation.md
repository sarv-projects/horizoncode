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

The remote source reviewed was `dead4339cae87f9e48c25e4e9586096d600bb164`; it has `kernel/`, `packages/core/`, `packages/opencode/` and `indexd/`, **not** the independent `horizoncode-runner`, `horizoncode-orchestrator`, `horizoncode-tools` or `horizoncode-tui` crates imagined in other reports. The key-shaped string in `opencode/packages/http-recorder/test/record-replay.test.ts` is inside a secret-detection fixture, not proof of a live credential. Do not rewrite Git history without actual alert and provenance confirmation. At the initial remote review checkpoint, GitHub Actions had zero runs; PR #1 subsequently ran full validation. For current commit-bound hosted results consult `HANDOFF.md` and the Actions checks, never assume this historical snapshot remains current. No benchmark or Experimental Settings runtime integration was verified by this documentation-only change. Use immutable source pins in §42 before translating rival code. The current implementation gate remains P1.3.

## Optional-feature Settings and Experimental class — A-V2-29

Integrate with the existing §16 Settings/config owner and §33 canonical capability/action registry; do not create a separate feature registry, feature daemon or TUI-only flags. `FeatureExposureV1` is a derived projection schema in `contracts-v2/feature-exposure-v1.schema.json`. The official maturity/release tag is `experimental` (then `beta`, `stable`), distinct from DESIGNED/CODE_PRESENT/WIRED/TESTED/VERIFIED/RELEASED and runtime unavailable/disabled reasons.

- [ ] At every optional feature introduction, register one searchable owning setting with stable key, default/scope, requested/effective/source/locked/apply-boundary and availability; display in Settings → Features, plus Settings → Experimental if classed experimental.
- [ ] Experimental default OFF; user explicitly opts in on eligible developer/early-access build. A DESIGNED/unsupported feature is disabled/unavailable, **never fake-enabled**. A developer-only feature is invisible as an actionable control in ordinary public builds.
- [ ] TUI command palette, help, tool/agent picker, running status and eventual desktop/web/API render `[Experimental]` or accessible equivalent from the **same descriptor**, and show effective status/reason. No TUI-only independent source of flags.
- [ ] Enabling a setting cannot override Guard/policy, change selected model/harness, launch paid inference, or perform an unauthorized effect. Apply boundary and next-turn/next-session/restart state are explicit.
- [ ] Run FEAT-001..010 in §32 with schema/registry validation before declaring a feature TESTED or VERIFIED; preserve safe disable/migration when class changes.

Examples that remain experimental/disabled until their runtime and benchmarks actually qualify: alternate native grep/gix backend, Hashline edit dialect, provider transport prewarm and CoW worktree backend. Deferred features (such as snapcompact) must not be mislabeled as operational merely by appearing under an Experimental heading.

### Feature-source audit and smallest implementation route (2026-10-14)

**Inspected source:** Core V2 and legacy V1 experimental/config/migration, OpenCode instance config/runtime flags and config API, GUI-local `settings.v3`, GUI Settings tabs, TUI config/app/command/status, schema and architecture validator. These paths **do not yet implement a shared feature exposure resolver, actionable Experimental Settings, or TUI labels**. Exact source-to-owner mapping: §20.10.1; UX semantics §16.15; runtime acceptance §32 FEAT-001..014.

- [ ] Inventory user-selectable optional controls and legacy experimental environment variables. Deliberately classify `OPENCODE_EXPERIMENTAL` inheritance so broad flags cannot silently enable newly governed experiments.
- [ ] Implement one derived `FeatureExposureV1` read/effective-state projection from existing backend config, source precedence, platform/build/eligibility and Guard constraints; don't make GUI-local `settings.v3` the execution authority.
- [ ] Implement narrow source-version-safe opt-in persistence using current config update owner. Concurrency, denied policy, pending turn/session/restart, rollback and opt-out must work.
- [ ] Add keyboard-accessible TUI Settings → Features/Experimental and GUI Settings entries plus command/status `[Experimental]` labels. All show the same effective runtime state and unavailable reason.
- [ ] Run schema/contract validator, V1/V2 binding tests and FEAT-001..014 actual integration. A passing generic typecheck or designed schema is not completion.

This work is part of P6 Settings/UX but must be integrated before *new optional effectful features* are presented as executable. It does not replace P1.3 Guard completion.


## P1 and P2 completion ledger — implementation gate, October 14 2026

STATUS: This maps existing source to remaining work, not a new subsystem or claim of release readiness. Completion source is HANDOFF.md and exact passing CI/OS evidence; Gate 2 and Gate 3 remain OPEN.

### P1: origins and required exact negative proof

| Priority | Existing owner/origin | What must be proved |
|---|---|---|
| 1 | packages/opencode/src/session/prompt.ts: shellImpl -> spawner.spawn | All shell/process/Git/build/test effects require kernel PREPARE and one-use ExecutionHost lease before spawn. Validate cwd/argv/env, sandbox profile, output bounds, process tree, cancellation and UNKNOWN. Do not break direct UX without providing a guarded replacement. |
| 2 | Same file: commandWork -> ConfigMarkdown.shell -> Process.text | No shell interpolation before Guard; denied, malformed or mixed substitutions spawn zero processes. |
| 3 | Same file: handleSubtask -> TaskTool.execute | Parent permission, workspace fence, budget, model/harness and child scope intersect; no Task spawn or child mutation without Guard. |
| 4 | packages/opencode/src/tool/registry.ts and hydrated plugin/hooks/MCP/code-mode implementations | Executable callbacks and network calls require pre-dispatch authority, not metadata classification or post-execution permission UI. Explicitly disable unmediated extensions. |
| 5 | packages/opencode/src/session/llm.ts and provider adapters | Opaque GitLab hosted workflow blocked in PR #4; audit and preempt remaining hosted execution, remote MCP and native tool paths. |
| 6 | packages/core/src/session, V1 legacy HTTP routes, maintenance jobs | All externally callable effectful operations cross the same kernel authority, including settings/auth/network and background jobs. |
| 7 | LSP/DAP/REPL/browser/desktop/automation/external agents | Every enabled action has canonical scope, authenticated origin, pre-launch Guard, resource generation and OS-specific confinement tests; otherwise UNAVAILABLE. |
| 8 | kernel/src/guard.rs and effect_host.rs | Generalize single files.write-only capability to complete atomic batches, durable PREPARED intents, exact one-use lease, receipts, UNKNOWN target reconciliation and no unsafe retry. |
| 9 | packages/opencode/src/session/tool-batch.ts | Preserve PR #3 partial-frame lifecycle tests, PR #4 abort propagation and hard bounded provider-stream deadline, 32-call and 256/512 KiB byte ceilings. |

P1 adversarial matrix: forged callback, stale call ID/capability, invalid streamed siblings, simultaneous conflicting effects, plugin/MCP alias bypass, symlink and path-swap attacks, environment/credential exposure, denied child shell, process escape, network/OS guarantee mismatch, explicit cancellation before and after PREPARE, lost target receipt and non-idempotent UNKNOWN. Unsupported host/platform capability must decline rather than claim best effort as enforced. Green typechecks are insufficient.

### P2: execution sequence and production acceptance

1. Authenticated Goal + immutable accepted FULL SpecVersion: objective, scope, constraints, criterion descriptions, budgets, project/workspace and source digests. A model or plugin cannot approve its own spec.
2. Existing Rust durable owner gets real Run/Task/Attempt event control and SessionLink correlation without a second canonical transcript. Tasks depend on independently verified PASS; Attempts carry actor/agent/provider, policy/owner epoch, workspace and retry budget.
3. Add bounded supervised scheduler, worker/worktree/resource leases, conflict graph, heartbeat, cancellation fences, explicit provider choice and guarded EffectHost dispatch. Worker completion alone is never Task PASS.
4. Reconcile effects/leases after process crash. Unsettled active Attempts enter RECONCILING; never automatically retry non-idempotent UNKNOWN, erase dirty state or leak child processes.
5. Trusted final verifier associates all accepted criteria with artifacts, test identities and current final integrated revision plus workspace overlay. Detect human edits/stale proof before SUCCEEDED; otherwise FAILED/NEEDS_YOU.
6. Wire authenticated API/TUI, user steering, pause/resume/stop, restart/reconnect. Test fan-in dependencies, arbitrary crash at each effect stage, stale owner fences, duplicate delivery, budget exhaustion, manual approval, success/failure/NEEDS_YOU and native Windows capability truth.

Current PR #4 implements only an INTERNAL OwnerLogV2 backed control projection and guarded stream hardening. It now has internal Task verification and criterion/final-revision state transitions, but NO independently authenticated verifier adapter, managed RPC/API, worker scheduler, effect target reconciliation, lease engine, or native Windows qualification. Keep P1 and P2 open until all above tests prove real end-to-end execution.

Do not create new agent loops, tool authorities, separate Rust conversation stores or competing feature registries. Use source paths above, existing Owners in 17, execution contract 14, lifecycle 11, schemas 12 and task fixtures 32.

## Resource-efficiency and JCode adoption implementation gates — 2026-10-15 (A-V2-30)

**Baseline:** Horizon `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54`, JCode `1jehuang/jcode@1f612a7`. This section records **newly accepted work, not completed work**. The normative owners are §17.10, §18.17, §20.11, §21.10, §29.17, §30.20, §31.16, §32.32, §33.29 and §37.15; this plan is the sole task-order tracker. Never interpret a checked research item as working runtime.

### RC0 — baseline and resource instrumentation (independent of mutation enablement)
- [x] Pin external JCode source and distinguish implemented vs Proposed/Design/Draft/Being implemented in §42.9.
- [x] Record current per-Session `SessionSupervisor.open` / `session_supervisor.rs` process topology and Rust managed admission truth.
- [ ] Add first-party `scripts/perf/` harness with Linux process-tree PSS/RSS/FD/CPU/threads, macOS footprint/native Windows private bytes. Tests for missing/permission-denied metrics and PID reuse; no fabricated zero.
- [ ] Add redacted, bounded process-tree ResourceSampler with host/kernel/Session/Run/Attempt/child/cache/local-model attribution and compatible sampling period.
- [ ] Record reproducible current Horizon/JCode controlled 1/5/10/20-session baseline and real task outcomes in `docs/performance/evidence/`, with exact commits, machine, build, warm/cold, embeddings, model selection and method.
- [ ] Decide per-platform release budgets/regression ratchets from evidence, then add CI test. **Do not claim JCode's PSS values for Horizon.**

### RC1 — mandatory P1 security and current supervisor
- [ ] Complete enabled tool-origin interception (direct shell/process, Task/subagent, hooks/MCP/plugins, provider-hosted, LSP/DAP/REPL, browser/desktop/network/automation) with pre-dispatch Guard/lease/receipt/UNKNOWN and no-bypass tests. Unsupported origins remain unavailable, not implicitly trusted.
- [ ] Measure baseline per-Session supervisor process count, per-SQLite observer cost, startup, watchdog/cursor and isolated effect write.
- [ ] Prototype **read-only** shared Rust SessionLink multiplexing behind `SessionSupervisor.Service` with peer-auth binding, per-Session queue/cursor/epoch/cancellation, bounded ACK and cross-session negative tests.
- [ ] Fault-inject one client abuse, one worker crash, kernel crash, malformed packet, conflicting owner and stale epoch; prove no cross-session read or mutation authority and no lost receipt.
- [ ] Only then consider shared effect-host cutover with full §14 P1 tests; preserve existing interface and rollback. Run JC-RES-001/002/008/009/010.

### RC2 — P2 useful managed execution and headless workers
- [ ] Wire reviewed full SpecVersion acceptance, authenticated kernel RPC and Rust Task DAG scheduling over existing managed state (no second Task database or transcript).
- [ ] Add resource-aware WorkerExecution/Attempt pool: lightweight read-only headless attachment, strict isolated process for untrusted effects; leases, cancel/kill tree/UNKNOWN settlement and idle reuse keyed by trust/config/workspace.
- [ ] Typed DAG edges carry artifact ref/source revision/criteria; cycle/depth/member caps, independent coverage review and final integrated-revision verification. Complete concurrent task/edit and crash recovery tests.
- [ ] Add source-generation-safe file-touch **advisory** index plus authoritative digest/lease precondition and collision UI. Run JC-RES-007/011/012/018.

### RC3 — P3/P6 practical daily coding and compatibility
- [ ] Provider Doctor offline/catalog/full under existing transport, model catalog and secret ownership; explicit spend confirmation, bounded requests and typed stream/tool-call diagnostics. JC-RES-013/014/015.
- [ ] Add transparent provider prewarm **only** for consented no-spend pools; distinguish selected local model warm/load from API warmup and record actual cache hits or unknown.
- [ ] Add one-owner external Session import preview/commit/resume with original provenance, no token/credential copy, no dual live transcript owner; test supported backend formats. JC-RES-019.
- [ ] Cap/attribute context, index, Markdown/Mermaid/image, provider projection and tool-tail bytes; opt-in scope-bound local recall, no mandatory embedding/remote account. JC-RES-003/005/020.

### RC4 — P7/P8 UX, operations and release acceptance
- [ ] Adaptive idle/deep-idle redraw with full-frame reason tracing and bounded in-place tool-tail; stable focus/scroll on 10k messages, 1000 streaming deltas and reconnect. JC-RES-006/016/017.
- [ ] Expose measured/estimated/unknown resource graph, per-Session/Attempt worker/process costs, provider diagnostics and conflict warnings in TUI/CLI and derived GUI/API (feature exposure truthful; experimental opt-in when necessary).
- [ ] 10/20 Session real-work task success + crash/unknown effect/pressure/lease and cross-OS qualification; CI perf ratchet and installer/licensing; preserve no automatic paid fallback. JC-RES-001..020 plus existing §32 security/recovery cases.
- [ ] Record exact binaries/build flags, benchmark raw evidence, negative/positive tests, platform matrix and user-approval gates in HANDOFF; append actual work diary to CURRENT_RUN.

### Engineering rule

Work on RC0 **without** claiming P1/P2 completion; proceed with required real Guard and managed execution in the existing Gate 2 → Gate 3 order. RC3/RC4 adapters may be designed/tested in isolation but must not expose effectful bypasses. `README.md` is a product page and must not become a RAM benchmark claim. Automatic hot-swap/self-dev remains developer-option work with independent rollback/security gates, not a reason to defer the fundamental engine.

### RC5 — remaining JCode adoption parity (not omitted)

The original 24-candidate audit includes supporting features beyond core RAM. Track all of them explicitly; implementation can overlap where different code owners/tests permit.

- [ ] **Active user steering and terminal input compatibility:** confirm existing durable steer/queue behaviour under concurrent streams; render queued/accepted/next-turn state, verify Shift+Enter/tmux/SSH, and never corrupt the selected provider request/cache prefix.
- [ ] **Cross-client SDK/protocol:** thin documented, authenticated TUI/CLI/web/desktop SDK over one Core Session and Rust managed owner; API version negotiation, reconnect/replay and simultaneous multi-client session activity, without new conversation authority.
- [ ] **Rich provider auth/catalog/compatibility:** evaluate JCode provider-source breadth alongside existing OpenCode/OMP candidates, reuse current transport/model picker and secret ownership, verify explicit user selection and cache/cost provenance with Doctor fixtures.
- [ ] **Tool intent and large-output opt-in:** add concise user-visible intent/purpose only behind canonical ActionDescriptor/ToolBatch schema; bounded output remains an artifact/stream, not an escape from limits.
- [ ] **Compile-time rebuild and release-resource hygiene:** profile Rust crate/Bun TypeScript invalidation, no duplicated heavyweight build trees, benchmark incremental compile and install size; only split modules after measured hot-path impact.
- [ ] **Multi-session activity map:** derived UI over the same Session/Run state, focus/scroll isolation, pausing/resuming and clean external terminal/tmux integrations; JCode multisurface is Proposed, not shipping proof.
- [ ] **Human-quality performance/demo trial:** repeat real user workflows and record authentic TUI video, input/stream p95, verification success, understandable errors and accessibility; never represent mock/demo placeholders as completed product.
- [ ] **Opt-in self-development/hot swap and thin mobile client:** developer-only signed/reversible canary with fencing and rollback; secure remote authenticated SDK client/mobile surface with no separate Task/Session engine, no exposed secrets and correct disconnect behaviour. Respect A-V2-29 Experimental settings and human authorization.

Source-to-feature coverage crosswalk: §42.10. These are accepted product capabilities with individually honest availability/evidence, **not an instruction to discard them on scope grounds**.

## Implementation-ready RC0–RC5 function/test ledger — 2026-10-15

**Authoritative design is in the topic owners; this ledger only orders code work.** All entries below are **NOT IMPLEMENTED by the documentation PR** unless separately identified in HANDOFF with source and real test evidence. Do not create a second Session, Task, tool registry, authorization engine or runtime in the name of JCode parity. The precise HLD is §01.13, API/IPC §13.12, state/durability §11.20, schema work §12.16, LLD §15.20/§18.18–19/§21.11/§29.18/§30.21/§31.17/§37.16–18 and tests §32.33–34.

| Deliverable | Concrete code boundary | Core functions / adapters to implement | Test gate |
|---|---|---|---|
| RC0.1 process-tree measurement | host supervisor + Rust/OS ResourceSampler, script harness under `scripts/perf/` | `resolveOwner, walkOwnedProcesses, readCounters, deduplicateTree, attributeByLease, sampleWithBudget` | JC-RES-001/002/003/004 |
| RC0.2 process/budget truth | Rust WorkerExecution/resource lease owner | `reserveCapacity, chargeActiveUsage, evaluatePressure, releaseIfSettled, reconcileOrphan` | JC-RES-006/012 |
| RC0.3 cache/renderer | existing context/index/TUI owners | `cache.lookup, insertIfCurrent, pin/unpin, evictToBudget` | JC-RES-005/006/020 |
| RC1.1 Guard closure | existing provider/callback/host paths + Rust `guard.rs/effect_host.rs` | complete atomic batch, classify origins, authorize, durable PREPARE, one-use lease, launch, receipt/UNKNOWN, cancel | existing P1 denial matrix + JC-RES-009 |
| RC1.2 shared read-only observer | `SessionSupervisor.Service` and Rust supervised IPC | `attach, subscribe_page, ack_page, detach, cancel_scope, read source cursor` with peer/epoch/queue quotas | JC-RES-008/009/010 |
| RC1.3 eventual shared effects | same Rust Guard and EffectService, feature-negotiated | migrate one effect class behind selected kernel owner, durable reconcile then release old supervisor | full §14 bypass/regression & benchmark |
| RC2.1 managed scheduler | Rust `managed_control.rs`/OwnerLog, authenticated API | `acceptFullSpec, graphValidate, readyTasks, admitAttempt, reserveResourceLease, settleDelivery` | JC-RES-007/018 + P2 |
| RC2.2 worker execution | Rust WorkerExecution + §14 ExecutionHost | `enqueue, reserve, attachExistingCoreClient, startIsolatedWorker, settleWorker, revokeLease` | JC-RES-007/009/012 |
| RC2.3 reviewer | existing Rust Evidence/Verification owner with independently authenticated adapter | `verifyCriterion, bindRevision, finalizeRun`; no child self-approval | JC-RES-018 |
| RC2.4 file-conflict safety | file watchers/handler + Rust guard revision preconditions | `recordObservedTouch, listForPath, invalidateGeneration, evictExpired`; hard write lease/hash validation separate | JC-RES-011 |
| RC3.1 Provider Doctor | existing selected provider/auth/catalog source; §37.17 | `inspectOffline, probeCatalog, probeFull` + consent and actual token/billing evidence | JC-RES-013/014/015 |
| RC3.2 context+recall | ContextLedger/indexd and selected model provider | `compileContext, recallScoped, getTokenBudget, invalidateSourceEpoch` | JC-RES-003/005/020 |
| RC3.3 session import | canonical host Session and explicit native backend adapter | `detectSources, previewImport, commitImport, detachExternalSession` | JC-RES-019 |
| RC4 TUI | hydrated existing renderer + UiEventMux | `normalizePaintEvent, stablePrefixDiff, coalesceReplaceableDelta, chooseFrameDeadline, paintChangedCells` | JC-RES-016/017 |
| RC4 surfaces | existing Settings FeatureExposure and API/TUI/app | `resolveEffectiveFeature, renderResourcePanel, renderProviderDoctor, showFileConflict` | FEAT-001..014 + resource suites |
| RC5 clients | existing public Session/API and authenticated backend adapters | `attachClient, subscribe/ack/replay, sendUserInput, steer, cancel` | replay/auth/single-owner/turn-epoch tests |
| RC5 dev canary/packaging | supervised build/test worker, release owner | `prepareCandidate, testAndAttest, requestUserApproval, activateCanary, rollback` | isolation/signature/rollback and disk/build cases |

**Definition of executable specification before marking a checkbox:** every selected function above has an existing/new concrete file path *in a hydrated checkout*, typed parameters/return/limits, ownership of durable vs derived data, error-code mapping, explicit concurrent/cancel/crash behaviour and a complete test with fixture bytes and method. §37 pseudotypes are not compiled/generated contracts: RC0–5 may be marked CODE_PRESENT only after actual modules/schema appear, WIRED only after real ingress/egress, VERIFIED only after security/OS/performance tests. Benchmarks from JCode or README screenshots are not runtime proofs.

**First coding commit recipe:** start with shell/process ToolBatch pre-dispatch denial and real guarded replacement (P1.3); in parallel add **read-only** ResourceSampler and process-tree baseline. Do not build the shared effect daemon first. After P1, a single authenticated managed goal-to-verifier integration slice establishes P2 before expanding workers. Keep native Windows unsupported paths explicitly unavailable until actual Windows source/OS CI passes. Follow `AGENTS.md` cleanup/worktree discipline.

## Missing accepted journey implementation ledger — ACP / visual / deployment (2026-10-15)

These flows were already accepted in §§3.16–3.18; prior implementation-specific resource hardening did not fully cover their host interfaces. They are **unchecked** until actual source/contract/system proof exists.

- [ ] **ACP outbound adapter (P6):** hydrate upstream OpenCode ACP server for source reuse, then add distinct Horizon client adapter through existing AgentProfile/DelegationMailbox and Rust worker/Guard. Implement version/auth/capabilities/session link, tool mediation, typed result, cancel/reconnect and UNKNOWN with tests ACP-001..008. Native OpenCode mode remains a separately owned backend, not a second direct Horizon Session writer.
- [ ] **Visual source selection (P5/P7):** browser/preview observation + build/source-map generation → bounded source candidates/ambiguity → approved guarded `files.patch` → re-observe/verification. Real VIS-001..004; do not turn a pixel or untrusted DOM into write authority.
- [ ] **Deployment (P5/P9):** provider/environment/account discovery and deterministic artifact manifest; explicit spend/secret/effect consent; Guard PREPARED/lease; target-side idempotency+receipts; real URL/revision health and critical workflow check; bounded rollback/reconciliation. Real DEP-001..008; no speculative production deployment or success from an upload alone.
- [ ] Add versioned generated machine contracts + canonical §33.30 candidate registrations and actual entry points before marking any new tool WIRED, and update HANDOFF with CI/OS/provenance. Source seam §20.13, safety §14.18, interfaces §37.19–20, tests §32.35. The existing P1 universal Guard is a prerequisite for effectful routes; do not invent a second execution engine.
