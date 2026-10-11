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
