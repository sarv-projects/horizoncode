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
- Additional V2 `files.patch` / session-revert increment (2026-10-13; Gate 2 remains open): Rust EffectHost admits bounded ordered patch batches through Guard with exact operation matching, file preimage/postimage validation, receipts and restart reconciliation. Core V2 `SessionRevert.stage/clear` uses a restore plan and `SessionSupervisor.runPatch`; its HTTP route test passed 1 / 5 through the local Linux supervisor. WebView and TUI callers use the existing V1 `/session/:id/revert` and `/unrevert` routes. Fixed legacy/Core persistence by validating legacy absolute revert paths, storing relative `restoreFiles`, and mapping them back to V1 absolute paths on read. Manual Linux UI evidence, projection regression and current typechecks are recorded in the 2026-10-13 checkpoint below. No Windows or full-workspace acceptance.
- Additional VCS and Workspace guarded patch increment (2026-10-13; Gate 2 remains open): `Vcs.apply` parses bounded unified diffs and routes them through `SessionSupervisor.runPatch`; local `Workspace.copyChanges` builds bounded operations and uses the same Rust Guard/ExecutionHost path. Remote/mixed workspace copy remains fail-closed. The TUI workspace dialog now allows copy only after explicit `yes`; its rendered dialog and Enter-key path pass a component test. Verification against the actual local Linux supervisor: VCS 13 tests / 24 assertions; Workspace 37 / 127; TUI confirmation 1 / 1; OpenCode and TUI typechecks pass. The VCS/Workspace tests require a file-backed EventV2 DB because Rust cannot observe in-memory DBs; the VCS fixture also needs a projected Session and Project row. Root overlay audit passes: 6,627 compared, 127 changed, no missing/hidden/stale entries. No Windows or manual WebView revert acceptance.

P1.3 terminal slice — acceptance gates are specified in §32.23 (TM-001 100 MB
bounded search and TM-002 stale generation; reuse these, do not duplicate) plus
PTY-001–PTY-006: model `bash`/TUI `!` Guard approval and denial; V1/V2 create and
unchanged `Pty.Info` compatibility; tickets, credentials and exact origins; legacy
and binary framing, replay, sequence gaps and backpressure; restart/fencing and
`UNKNOWN`; native Windows ConPTY/pipe authentication/Job Object cleanup. Contract
details are in §§14.2–14.3, 30.17, 33.7/33.23 and 37.13; `terminal.resize` is
`guarded_effect`, with the registry/runtime mapping specified in §33.7. These are
required acceptance gates, not evidence of implementation or test completion.


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
- [ ] debug.\* adapter lifecycle, breakpoints/step/variables;
- [ ] guarded debug.evaluate with disable policy;
- [ ] repl.\* bounded Python/JavaScript lifecycle;
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

## Deferred post-V1 technical-debt gate — HorizonCode-only naming and fast TypeScript builds

**Schedule after V1 completion only; not part of the current P1.3 implementation and not a reason to delay delivery.** The normative owner is `arch_V1/10-DELIVERY.md §10.12`.

- [ ] Benchmark the existing TypeScript/Bun/Turbo build/typecheck/test graph; refactor package boundaries, project references, generated typings, caching, dependency invalidation and CI gates for efficient targeted iteration without weakening the full release gate.
- [ ] Complete the staged first-party migration to `horizoncode` naming throughout package metadata/scopes, CLI executable(s), binaries, generated clients, internal first-party imports, UI, docs, settings and distribution artifacts; retain `hzcode` only as an intentional short alias.
- [ ] Preserve pinned upstream compatibility and required OpenCode dependency identities, copyright and notices until an explicitly tested replacement is safe. Product identity and legal source attribution are different things.
- [ ] Validate a clean clone/install, Linux and Windows builds, typecheck/test matrices, real Guard flows, published-tarball dry run, update/back-compat and rollback; remove temporary aliases only with proof.
- [ ] Record measured build time, cache hit rate, disk usage and failure diagnostics before and after the refactor. Prevent multiple equivalent expensive builds.

Gate status: **DEFERRED / NOT STARTED** until V1's integrated verification and release baseline exist. Do not bulk-rename source or loosen checks now.

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

## Current evidence checkpoint — 2026-10-13

- P1.2-B is complete for the currently claimed local lifecycle scope; P1.3 remains the active implementation gate.
- `bun run typecheck` passes in `packages/core`, `packages/opencode`, and `packages/tui`; `packages/app` typecheck passed on unchanged caller source. Full 36-package Turbo typecheck passed on 2026-10-12 but was not rerun after the current P1.3 changes.
- Historical actual V1 `files.write` passes Rust admission -> approval -> execution -> receipt; denial, missing-challenge and complete-batch tests pass.
- Rust `files.patch` now supports bounded ordered batches with Guard binding, preimage/postimage validation, receipts and restart reconciliation. The full kernel suite previously passed 160 tests / 15 suites.
- V2 revert stage/clear HTTP integration passed 1 test / 5 assertions through the real local Linux Rust supervisor. WebView and TUI callers use V1 `/session/:id/revert` and `/unrevert`, with manual interaction evidence below.
- Focused tests: Core snapshot 4 / 19 and V1 projection 10 / 23; OpenCode `apply_patch` 9 / 30, snapshot 53 / 630, prompt/tools/write 49 passed / 1 skipped / 178; V2 revert HTTP 1 / 5; VCS 13 / 24; Workspace 37 / 127; TUI workspace confirmation 1 / 1; prompt retry/promotion 1 / 10; full `httpapi-session.test.ts` 27 / 148. The prior prompt-wake failure was fixed by forwarding `createRoutes` Layer replacements into `buildLocationServiceMap`.
- Overlay audit: 6,627 pinned files compared; 127 changed, 0 missing, 0 symlink deltas, 0 hidden changed/new source files and 0 stale unignore rules. Fresh-clone hydration, architecture convergence and provenance checks passed at prior checkpoints.
- Full 36-package Turbo typecheck passed on 2026-10-12, but was not rerun after this P1.3 increment. Full integrated release/CI validation remains open.
- Local Linux WebView Vite UI used the live local API: `Revert message` and `Restore message` invoked V1 revert/unrevert requests (both HTTP 200) and toggled the Guarded file `after` -> `before` -> `after`. TUI write/undo/redo and the outside-worktree Guard denial were also exercised. Windows acceptance remains absent; frontend typechecks and Linux UI/backend evidence do not establish Windows acceptance.
- OMP transport/catalog migration, native OpenCode adapter, visual edit and deployment flows are DESIGNED, not production-wired.
- P1.3 terminal slice (2026-10-13): the guarded-PTY contract is accepted/review READY in `.slim/deepwork/horizon-guarded-pty.md` `#4232`; §§14/30/32/33/37 and `10-DELIVERY.md` were updated. Partial, unverified source now includes Rust terminal validation/replay primitives, a claimed Linux PTY/Windows ConPTY process backend, `ownerEpoch` HelloResult and a projection-only `session_supervisor`. There is still no proven `hz-kernel` host singleton/lease/multiplexed RPC/Guard dispatch/terminal event-artifact-recovery service, nor complete Core/root WebView/TUI `!` integration; old V1/V2 PTY runtime still reaches Bun process effects. No terminal-slice tests/builds/formatters ran. `kernel/src/terminal.rs`, `kernel/src/terminal_process.rs`, and `packages/core/src/trusted-principal.ts` are ignored by `.gitignore:6 (*)`; restore Git visibility only after reviewing the user's dirty ignore rules. Windows named-pipe DACL/owner proof, live Guard flows and native Windows acceptance remain absent.
- Question/clarification status: built-in `question`/`question.ask` is CODE_PRESENT, WIRED and TESTED through service/component/mock coverage for multi-question, single/multiple choice, custom text, answer and dismiss; it is **not** specified in canonical catalog `33`, domain schema `12`, acceptance catalog `32`, or the operative P1.3 plan, and has no live-runtime verification. The new TUI mixes V2 list with V1 reply/reject. Guard permission `ASK` is a different feature. The user marked ask/MCQ support important; track architecture, route-parity and live acceptance before claiming V1 completion.
- Exact current commands/results live in `HANDOFF.md`; historical implementation increments above remain provenance, not the current status authority.
