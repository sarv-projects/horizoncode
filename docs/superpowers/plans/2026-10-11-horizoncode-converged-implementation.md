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
- [ ] Preserve the distinction between pre-dispatch all-or-none validation and execution: partial effects may occur after dispatch; record per-effect receipts/UNKNOWN, cancellation and rollback limits, and reconcile before dependent retry.
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

- Additional Core V2 increment (2026-10-11): `ToolRegistry.materialize` in `packages/core/src/tool/registry.ts` omits registrations whose capability `effectClass` is unknown from both model definitions and the settlement snapshot. The regression checks missing and explicit unknown classifications are absent and return `Unknown tool` at validation/settlement without invoking them. Verification: `cd packages/core && bun test test/session-runner-tool-registry.test.ts` — 19 passed / 41 assertions; `bun test test/session-runner.test.ts` — 93 passed / 308 assertions; `bun run typecheck` passed. No live provider/platform was exercised; legacy/HorizonCode CLI-host package and other external effect origins remain unmediated.
- Additional Core supervisor ownership guard (2026-10-11): `SessionSupervisor.watchSession` reserves a Session ID for one observer within its service instance, returns a typed ownership failure through the readiness Deferred on duplicates, and releases the reservation at scope exit. `SessionExecutionLocal` propagates the failure before `SessionRunner.run`; the live test verifies duplicate rejection and later sequential watcher recovery. Verification: `cd packages/core && bun test test/kernel-projection-live.test.ts -t "SessionRunner binds its generated digest through Rust effects.v2 and denies multi-write batches"` — 1 passed / 18 assertions using the local Rust sidecar; `bun test test/session-runner-recorded.test.ts` — 1 passed / 24 assertions; `bun run typecheck` passed. Observer duplication remains scoped to one Supervisor instance; Gate 2 remains open.
- Additional same-process V1/V2 ownership and preflight (2026-10-12; Gate 2 remains open): the module-level Session lease is keyed by Session ID and backend class (`core-v2` / `opencode-v1`), permits nested same-class scopes by refcount, and rejects cross-class overlap. Core V2 acquires before observer startup; V1 loop/shell, prompt/command, and summarize acquire before provider execution or their persistence/interpolation/compaction prework. The init handler preserves the typed busy failure; prompt_async preflights synchronously before forking, and the child repeats its lease. Public HTTP 409 is declared for init, prompt, prompt_async, command, and summarize. Verification: owner nesting 1 test / 3 assertions; V1 preflight 1 / 11; prompt conflict-before-persistence 1 / 3; command conflict-before-shell-interpolation 1 / 3; cassette provider + Linux Rust observer cross-flow 1 / 28; OpenAPI 409 1 / 9; HTTP mapper 1 / 2; summarize HTTP 409/prework 1 / 3; init + async prompt HTTP 409/prework 1 / 5. Those historical bounded typecheck attempts timed out without diagnostics; current follow-up package typechecks for Core and packages/opencode now pass independently. No live provider inference.
- Current V1 increment (2026-10-12; Gate 2 remains open): `Tool.Def` now carries canonical capability metadata through `ToolRegistry.tools`; `SessionTools.resolve` only exposes classified read-only builtins, the supported `files.write`, and internal control tools. The pinned `ai@6.0.168` V3 `wrapStream` gate buffers tool calls to terminal `tool-calls`, validates the complete batch, and asks the session-owned Rust supervisor to prepare non-read-only batches before callbacks. Missing/unknown/malformed/duplicate/mixed/unowned/cancelled/incomplete batches fail closed. A single admitted `files.write` passes its challenge into the existing PermissionV1 edit approval, then Rust `approveEffect`/`executeWrite`; local direct write was removed. Verification: tool batch 8 passed / 28 assertions; prompt capability + Rust-owner-unavailable integration 2 passed / 4 assertions; missing-challenge write regression 1 passed / 3 assertions. The denial path uses fake/unavailable-supervisor coverage, and the positive V1 write now also passes through the actual local Rust supervisor with approval/execution/receipt assertions. Both modified TypeScript packages pass independently. Other direct shell/subtask/command/plugin/MCP/LSP/HTTP origins remain outside this slice; provider-executed tools are only rejected on returned chunks and cannot be reversed after remote execution. Do not report P1.3/Gate 2 complete. Next: migrate or disable every remaining inventoried effect origin with negative/recovery coverage.
- Additional V2 `files.patch` / session-revert increment (2026-10-13; Gate 2 remains open): Rust EffectHost admits bounded ordered patch batches through Guard with exact operation matching, file preimage/postimage validation, receipts and restart reconciliation. Core V2 `SessionRevert.stage/clear` uses a restore plan and `SessionSupervisor.runPatch`; its HTTP route test passed 1 / 5 through the local Linux supervisor. WebView and TUI callers use the existing V1 `/session/:id/revert` and `/unrevert` routes. Fixed legacy/Core persistence by validating legacy absolute revert paths, storing relative `restoreFiles`, and mapping them back to V1 absolute paths on read. Manual Linux UI evidence, projection regression and current typechecks are recorded in the 2026-10-13 checkpoint below. No Windows or full-workspace acceptance.
- Additional VCS and Workspace guarded patch increment (2026-10-13; Gate 2 remains open): `Vcs.apply` parses bounded unified diffs and routes them through `SessionSupervisor.runPatch`; local `Workspace.copyChanges` builds bounded operations and uses the same Rust Guard/ExecutionHost path. Remote/mixed workspace copy remains fail-closed. The TUI workspace dialog now allows copy only after explicit `yes`; its rendered dialog and Enter-key path pass a component test. Verification against the actual local Linux supervisor: VCS 13 tests / 24 assertions; Workspace 37 / 127; TUI confirmation 1 / 1; HorizonCode CLI-host package and TUI typechecks pass. The VCS/Workspace tests require a file-backed EventV2 DB because Rust cannot observe in-memory DBs; the VCS fixture also needs a projected Session and Project row. Root overlay audit passes: 6,627 compared, 127 changed, no missing/hidden/stale entries. No Windows or manual WebView revert acceptance.

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
- [ ] requested/effective Lightweight/Adaptive/Full profile over one index; exact base-generation and owner-bound overlay provenance; build coalescing, corruption rebuild and typed quality/fallback reporting;
- [ ] existing resource/cache owner throttles optional indexing/embeddings under pressure; stale query-to-files.patch fences reject changed source;
- [ ] bounded log/artifact search;
- [ ] context/tool discovery for small models;
- [ ] benchmark any native OMP-inspired walker/AST optimization before adoption.
- [ ] route LSP document synchronization through authenticated `repo-intel.v1/read_document`; no Core/app-process filesystem fallback, and stale/denied/oversized/symlink/non-UTF8 reads must stay unavailable.

Exit: common coding change is fast, source-grounded and Guarded.

## Gate 5 — P4 LSP, DAP and persistent REPL

Use §30, §37 and §33.

- [ ] reuse healthy editor LSP where possible;
- [ ] supervised LSP lifecycle/query pins, owner-safe idle eviction, resource-admitted startup and typed fallback/stale-result behavior;
- [ ] OS-enforced helper filesystem/process/network confinement; unavailable when the platform cannot enforce the declared profile;
- [ ] code actions/rename through canonical file effect;
- [ ] debug.\* adapter lifecycle, breakpoints/step/variables;
- [ ] guarded debug.evaluate with disable policy;
- [ ] passive DAP inspection remains distinct from getters/expressions that execute target code;
- [ ] repl.\* bounded Python/JavaScript lifecycle;
- [ ] state persists only inside a REPL generation;
- [ ] authenticated owner/workspace/sandbox-generation/capability-ceiling binding and OS-enforced REPL isolation;
- [ ] tool callback re-enters ActionDescriptor/Guard;
- [ ] crash/reset/idle-expiry invalidates refs.
- [ ] project immutable Core Config `ExecutionLaunchProfileV1` to HostKernel; resolve executable, derive cwd from registered Location, pass literal profile argv only, sanitized environment, no interpolation or P4-supplied process fields; bind HostProcessRef generation/epoch and receipts.
- [ ] use the existing `execution.v1`/single ExecutionHost prepare-launch-IO-cancel-status boundary; deny before spawn on stale profile, missing Guard lease, unsupported confinement or unresolved process state. DAP debuggee launch/attach is separately Guarded; REPL stays unavailable until required OS resource limits are enforced.
- [ ] make the private profile IPC match `ExecutionLaunchProfileDefinitionV1.executableSelector`; HostKernel resolves that trusted selector and never accepts a caller-supplied executable path. Include strict `HostProcessRefV1` schema/parity for each actually supported process kind, with profile/executable pins and no PID/path authority.

Exit: no language/debug/REPL route has ambient host authority.

## Gate 6 — P5 browser/desktop (post-V1) and built-in web search (V1 since 2026-10-18)

**Browser/desktop:** not a V1 release gate under A-V2-31. Keep every browser/desktop route unavailable; do not spend V1 implementation time there. Preserve those checkboxes as future acceptance if the scope is separately promoted.

**Web search (V1):** promoted into V1 by the 2026-10-18 user scope decision (`DEC-V1-26`). No box below is complete without exact tests:

- [ ] web.search direct vs grounded provider routes;
- [ ] built-in default route resolves without user configuration, or reports an honest unavailable reason;
- [ ] BYO-key providers (Brave, Exa, …) enable/credential/order in Settings (§16.7);
- [ ] enabled routes cascade in settings order; route failure falls through; exhausted chain → one bounded retry + per-route reasons;
- [ ] no route used unless enabled/configured (enable = consent); no hidden paid fallback;
- [ ] provider/auth/cost/freshness provenance on every result; `web.search.inspect_provider` honest status;
- [ ] timeout/rate-limit/offline stable errors; untrusted-content/injection handling;
- [ ] cancellation, bounds and artifactization for large fetched content.

**Browser/desktop checkboxes (post-V1 only):**
- [ ] browser managed vs attached context ownership;
- [ ] generation-bound DOM/ARIA/screenshot refs;
- [ ] guarded navigation/click/type/upload/download;
- [ ] desktop displays/windows/AX/screenshot capability matrix;
- [ ] guarded focus/input/clipboard, DPI/geometry correctness;
- [ ] worker/back-end crash and stale-ref tests;
- [ ] real supported-OS/provider journeys.

Exit: privileged interaction is mediated and support status truthful.

## Gate 7 — P6 agents/extensions/provider/model/settings UX (V1 CLI/TUI)

Use §16, §29, §33.

- [ ] AgentProfile/Harness registry and bounded specialists.
- [ ] Skill/Hook/MCP/plugin sealed IDs and trust/capability boundaries.
- [ ] one ActionDescriptor for slash/menu/key/API/model.
- [ ] agent/harness picker constrains model picker correctly.
- [ ] provider/model/role hub with cost/auth/status provenance.
- [ ] Adapt compatible non-OpenCode provider/auth/model integrations primarily from pinned OMP under Horizon's existing provider, auth, catalog and direct-Session owners; no account rotation or hidden fallback.
- [ ] For an explicitly selected native OpenCode backend, pin one official SDK/API generation and prove the actual provider/model list, streaming and account entitlements; SDK presence is not universal model access.
- [ ] schema-driven settings requested/effective/source/locked/apply boundary.
- [ ] Goal draft/review/accept UI before managed effects.
- [ ] V1 CLI/TUI underlying action/state parity; web/desktop parity is post-V1.
- [ ] credentials never leak.

## Gate 8 — P7 streaming/artifacts/analytics/automation (V1 CLI/TUI)

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

## Gate 9 — P8 resource efficiency, long-horizon/recovery/evaluation (V1)

- [ ] bounded worktree/resource pool;
- [ ] reproducible RC0 process-tree baseline at 1/5/10/20 sessions and measured optimization with identical task success; local-model memory accounted separately;
- [ ] bounded worker/subagent pool and typed DAG only after the P2 single managed Attempt and independent verifier pass;
- [ ] deterministic recovery across host/kernel/worker/provider failure;
- [ ] stop criteria avoid quota waste;
- [ ] §32 real-work suites across model classes;
- [ ] security bypass suite;
- [ ] performance budgets;
- [ ] final integrated revision verification.

## Gate 10 — P9 Linux/WSL CLI/TUI packaging/release

- [ ] license/notices closure;
- [ ] native platform support matrix;
- [ ] explicitly mark native Windows unavailable until native tests pass; WSL is not Windows evidence;
- [ ] signing/update/rollback if enabled;
- [ ] config/data migration;
- [ ] clean-install/upgrade;
- [ ] release UX/security/performance gates.

## Deferred post-V1 technical-debt gate — HorizonCode-only naming and fast TypeScript builds

**Schedule after V1 completion only; not part of the current P1.3 implementation and not a reason to delay delivery.** The normative owner is `arch_V1/10-DELIVERY.md §10.12`.

- [ ] Benchmark the existing TypeScript/Bun/Turbo build/typecheck/test graph; refactor package boundaries, project references, generated typings, caching, dependency invalidation and CI gates for efficient targeted iteration without weakening the full release gate.
- [ ] Complete the staged first-party migration to `horizoncode` naming throughout package metadata/scopes, CLI executable(s), binaries, generated clients, internal first-party imports, UI, docs, settings and distribution artifacts; `horizoncode` is the canonical user-facing executable name and `hzcode` is its shipped short command (both start the same CLI entrypoint; amended 2026-10-18).
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
| Snapcompact (transient imaging and persistent archive are distinct) | DEFERRED/UNAVAILABLE in V1; no runtime code, toggle or capability; reconsider only after P1.3 and context baselines | Same-model fidelity, capability and image-token/count/byte limits; privacy, cost/cache, recovery/rollback; exact source license/dependency review |

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
- [ ] **V1 remaining capability gates:** Continue LSP, DAP, persistent REPL, built-in web search (promoted 2026-10-18, `DEC-V1-26`), skills/hooks/plugin and guarded local MCP integration, providers, CLI/TUI settings, artifacts/rendering/analytics, local agents/workers and Rust-owned automation within their approved owners, independently tested and accurately labeled. Browser, desktop, web/desktop/mobile SDK clients and outbound ACP/VIS/DEP remain post-V1 under A-V2-31.

#### Selected next four major slices (2026-10-15)

1. **P1.3 host-kernel runtime and package closure.** Follow the normative host-scoped `hz-kernel` contract in §§14/37; implement the Rust host process and inject its target manifest/asset through `packages/opencode/script/build.ts`, then wire Core's existing authenticated client. Acceptance: real host handshake/READY and durable owner epoch; actual effects RPC; Guard denial before mutation; explicit approval, one-use lease, receipt/UNKNOWN recovery; the per-Session projection worker remains separate. Verify the built artifact through Core↔Rust IPC. Linux/WSL evidence does not qualify native Windows.
2. **P1.3 first direct shell/process origin.** Close the actual `packages/opencode/src/session/prompt.ts` `shellImpl -> spawner.spawn` route before touching broader origin classes. Require complete bounded ToolBatch admission before spawn; malformed/mixed/ASK/DENY/timeout cases launch zero processes; an allowed call consumes one lease and records outcome; cancellation, restart and UNKNOWN are reconciled. Use the existing PTY-001–006 contract and preserve the selected provider/model/harness.
3. **RC0 resource sampler and reproducible baseline (parallel).** Add OS-owned process-tree sampling and attribution to the existing resource owner, not a dashboard. Record Linux PSS/RSS/CPU and native Windows private bytes separately; reproduce 1/5/10/20-session workloads with hardware, cache, task, provider/model/harness and local-inference conditions bound to raw artifacts. Never kill unrelated processes or claim WSL as Windows evidence.
4. **P2 single managed vertical.** Only after P1.3 admission is proven: accepted SpecVersion → one Task/Attempt → one bounded action through the same Guard → durable receipt/evidence → independent verification of the final integrated revision. Prove pause/cancel/restart/UNKNOWN and human-edit conflict before worker fan-out.

Snapcompact is not one of these slices. Its future experiment remains blocked on the existing context/accuracy/cost/privacy gates; no new session owner or shortcut is introduced.

**Implementation checkpoint (2026-10-15):** Core `MessageChannel` now fences outbound application frames with the authenticated `ownerEpoch`/`processIncarnation`, rejects missing or mismatched inbound fencing, and uses the declared `msgpackr` codec; regression tests cover all ten Rust application-frame kinds and malformed fence values at the Rust 256-byte UTF-8 boundary. Core frame tests: 7 pass / 35 assertions; Rust `frame_fence_rejects_foreign_epoch_or_incarnation`: 1 pass. `packages/opencode/script/build.ts` now has native Linux GNU host-artifact/manifest logic but emits `unavailable` while `kernel/Cargo.toml` has no `hz-kernel` binary; Windows host packaging and Core named-pipe/runtime support remain unavailable. A direct `terminal.run` deny-before-dispatch smoke could not load the hydrated ignored `packages/core/src/pty.ts`: module evaluation throws `ReferenceError: input is not defined` at line 995; that overlay also has 40 typecheck diagnostics and was left untouched. This closes only wire-fence interop and a fail-closed packaging path. No effects/terminal end-to-end path has been established; do not mark slice 1 complete. Core typecheck remains non-green at 92 diagnostics across 23 files; none were reported in the new frame-fence helpers or their regression test.

### Six benchmark lanes, not another dashboard

Store small versioned JSON/CI artifacts bound to commit, OS, CPU/RAM, fixture, provider/model/harness, permission mode and cache state. Measure (1) cold/warm composer-ready, TTFT and first useful output with stage breakdown; (2) first *correct* repository search hit, incremental edit/rename/branch-switch update and stale window; (3) context/tool bytes, tokens, protected-fact retention, compaction latency and subsequent re-fetch; (4) first-edit success, stale conflict, retry count, final regressions and token cost by dialect; (5) 1/2/4/8 worker final verified success, wall time, conflicts, coordination, disk and cost; (6) TUI input/frame p95, scroll/focus, recomposition/CPU/memory at 100/1K/10K transcript blocks and parallel streams. Distinguish harness time, provider inference and **total verified task time**. Tool-ready ≠ feature WIRED; passing mocks ≠ end-to-end VERIFIED; existing GitHub workflow YAML ≠ green CI run.

### Evidence and source-truth rules

The remote source reviewed was `dead4339cae87f9e48c25e4e9586096d600bb164`; it has `kernel/`, `packages/core/`, `packages/opencode/` and `indexd/`, **not** the independent `horizoncode-runner`, `horizoncode-orchestrator`, `horizoncode-tools` or `horizoncode-tui` crates imagined in other reports. The key-shaped string in `opencode/packages/http-recorder/test/record-replay.test.ts` is inside a secret-detection fixture, not proof of a live credential. Do not rewrite Git history without actual alert and provenance confirmation. At the initial remote review checkpoint, GitHub Actions had zero runs; PR #1 subsequently ran full validation. For current commit-bound hosted results consult `HANDOFF.md` and the Actions checks, never assume this historical snapshot remains current. No benchmark or Experimental Settings runtime integration was verified by this documentation-only change. Use immutable source pins in §42 before translating rival code. The current implementation gate remains P1.3.

## Optional-feature Settings and Experimental class — A-V2-29

Integrate with the existing §16 Settings/config owner and §33 canonical capability/action registry; do not create a separate feature registry, feature daemon or TUI-only flags. `FeatureExposureV1` is a derived projection schema in `contracts-v2/feature-exposure-v1.schema.json`. The official maturity/release tag is `experimental` (then `beta`, `stable`), distinct from DESIGNED/CODE_PRESENT/WIRED/TESTED/VERIFIED/RELEASED and runtime unavailable/disabled reasons.

- [ ] At every optional feature introduction, register one searchable owning setting with stable key, default/scope, requested/effective/source/locked/apply-boundary and availability; display in Settings → Features, plus Settings → Experimental if classed experimental.
- [ ] Experimental default OFF; user explicitly opts in on eligible developer/early-access build. A DESIGNED/unsupported feature is disabled/unavailable, **never fake-enabled**. A developer-only feature is invisible as an actionable control in ordinary public builds.
- [ ] V1 TUI command palette, help, tool/agent picker, running status and CLI/SDK surfaces render `[Experimental]` or equivalent from the **same descriptor**, and show effective status/reason. Future desktop/web consumers must reuse that projection; no TUI-only independent source of flags.
- [ ] Enabling a setting cannot override Guard/policy, change selected model/harness, launch paid inference, or perform an unauthorized effect. Apply boundary and next-turn/next-session/restart state are explicit.
- [ ] Run FEAT-001..010 in §32 with schema/registry validation before declaring a feature TESTED or VERIFIED; preserve safe disable/migration when class changes.

The 2026-10-15 source review in §§16.15.2/30.4/42 SRC-024 finds future ContextService projection architecturally plausible but not integration-ready: Core V2 lacks the owner, exact-model image metadata, image-aware budget and local renderer. Snapcompact is outside the next four V1 slices; no executable setting or runtime claim is appropriate.

### Feature-source audit and smallest implementation route (2026-10-14)

**Historical source snapshot (2026-10-14; superseded by the 2026-10-15 live-overlay correction and A-V2-31):** Core V2 and legacy V1 experimental/config/migration, OpenCode instance config/runtime flags and config API, GUI-local `settings.v3`, GUI Settings tabs, TUI config/app/command/status, schema and architecture validator were inspected. At that snapshot these paths did not implement the later shared projection/UI. Current first-party CODE_PRESENT/PARTIAL status and V1 CLI/TUI scope are recorded in `HANDOFF.md`, §20.10.1 and `implementationtov1release.md`; app GUI is not a V1 acceptance surface. Exact runtime acceptance remains §32 FEAT-001..014.

- [ ] Inventory user-selectable optional controls and legacy experimental environment variables. Deliberately classify `OPENCODE_EXPERIMENTAL` inheritance so broad flags cannot silently enable newly governed experiments.
- [ ] Implement one derived `FeatureExposureV1` read/effective-state projection from existing backend config, source precedence, platform/build/eligibility and Guard constraints; don't make GUI-local `settings.v3` the execution authority.
- [ ] Implement narrow source-version-safe opt-in persistence using current config update owner. Concurrency, denied policy, pending turn/session/restart, rollback and opt-out must work.
- [ ] Add keyboard-accessible V1 TUI Settings → Features/Experimental and command/status `[Experimental]` labels. GUI/web settings entries are post-V1; future consumers must project the same effective runtime state and unavailable reason.
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

**Baseline:** Horizon `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54`, JCode `1jehuang/jcode@1f612a7`. This section records **newly accepted work, not completed work**. The normative owners are §17.10, §18.17, §20.11, §21.10, §29.17, §30.20, §31.16, §32.32, §33.29 and §37.16; this plan is the sole task-order tracker. Never interpret a checked research item as working runtime.

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

- [ ] **Active user steering and terminal input compatibility:** confirm existing durable steer/queue behaviour under concurrent streams; render queued/accepted/next-turn state; verify UI-016/017 ordering and restart acceptance plus Shift+Enter/tmux/SSH; never corrupt the selected provider request/cache prefix.
- [ ] **V1 CLI/TUI SDK/protocol:** thin documented, authenticated CLI/TUI SDK over one Core Session and Rust managed owner; API version negotiation, reconnect/replay and simultaneous local client activity, without new conversation authority. Remote/mobile/web/desktop SDK clients and hosting remain post-V1.
- [ ] **Rich provider auth/catalog/compatibility:** evaluate JCode provider-source breadth alongside existing OpenCode/OMP candidates, reuse current transport/model picker and secret ownership, verify explicit user selection, RC-011 failure/retry behavior, and cache/cost provenance with Doctor fixtures.
- [ ] **Tool intent and large-output opt-in:** add concise user-visible intent/purpose only behind canonical ActionDescriptor/ToolBatch schema; bounded output remains an artifact/stream, not an escape from limits.
- [ ] **Compile-time rebuild and release-resource hygiene:** profile Rust crate/Bun TypeScript invalidation, no duplicated heavyweight build trees, benchmark incremental compile and install size; only split modules after measured hot-path impact.
- [ ] **Multi-session activity map:** derived UI over the same Session/Run state, focus/scroll isolation, pausing/resuming and clean external terminal/tmux integrations; JCode multisurface is Proposed, not shipping proof.
- [ ] **Human-quality performance/demo trial:** repeat real user workflows and record authentic TUI video, input/stream p95, verification success, understandable errors and accessibility; never represent mock/demo placeholders as completed product.
- [ ] **Post-V1 separately gated:** developer-only signed/reversible self-development/hot-swap canary and secure remote/mobile SDK surface with fencing, rollback and no separate Task/Session engine. These are not V1 release gates; preserve A-V2-29 and human authorization if later promoted.

Source-to-feature coverage crosswalk: §42.10. These are accepted product capabilities with individually honest availability/evidence, **not an instruction to discard them on scope grounds**.

## Implementation-ready RC0–RC5 function/test ledger — 2026-10-15

**Authoritative design is in the topic owners; this ledger only orders code work.** All entries below are **NOT IMPLEMENTED by the documentation PR** unless separately identified in HANDOFF with source and real test evidence. Do not create a second Session, Task, tool registry, authorization engine or runtime in the name of JCode parity. The precise HLD is §01.13, API/IPC §13.12, state/durability §11.20, schema work §12.16, LLD §15.20/§18.18–19/§21.11/§29.18/§30.21/§31.17/§37.17–19 and tests §32.33–34.

| Deliverable | Concrete code boundary | Core functions / adapters to implement | Test gate |
|---|---|---|---|
| RC0.1 process-tree measurement | host supervisor + Rust/OS ResourceSampler, script harness under `scripts/perf/` | `resolveOwner, walkOwnedProcesses, readCounters, deduplicateTree, attributeByLease, sampleWithBudget` | JC-RES-001/002/003/004 |
| RC0.2 process/budget truth | Rust WorkerExecution/resource lease owner; §11.20 sole reservation/pressure state enum, §18.18 accounting | `reserveCapacity, chargeActiveUsage, evaluatePressure, releaseIfSettled, reconcileOrphan`; prevent `ACTIVE`/`UNKNOWN` shadow states, double debit and expiry-after-launch free | JC-RES-006/012.C–J |
| RC0.3 cache/renderer | existing context/index/TUI owners | `cache.lookup, insertIfCurrent, pin/unpin, evictToBudget` | JC-RES-005/006/020 |
| RC1.1 Guard closure | existing provider/callback/host paths + Rust `guard.rs/effect_host.rs` | complete atomic batch, classify origins, authorize, durable PREPARE, one-use lease, launch, receipt/UNKNOWN, cancel | existing P1 denial matrix + JC-RES-009 |
| RC1.2 shared read-only observer | `SessionSupervisor.Service` and Rust supervised IPC | `attach, subscribe_page, ack_page, detach, cancel_scope, read source cursor` with peer/epoch/queue quotas | JC-RES-008/009/010 |
| RC1.3 eventual shared effects | same Rust Guard and EffectService, feature-negotiated | migrate one effect class behind selected kernel owner, durable reconcile then release old supervisor | full §14 bypass/regression & benchmark |
| RC2.1 managed scheduler | Rust `managed_control.rs`/OwnerLog, authenticated API | `acceptFullSpec, graphValidate, readyTasks, admitAttempt, reserveResourceLease, settleDelivery` | JC-RES-007/018 + P2 |
| RC2.2 worker execution | Rust WorkerExecution + §14 ExecutionHost; authenticated ingress/Task/Attempt/owner epoch on every request | `enqueue, reserve, attachExistingCoreClient, startIsolatedWorker, settleWorker, revokeLease`; untrusted ticket/lease alone cannot launch | JC-RES-007/009/012.H–K |
| RC2.3 reviewer | existing Rust Evidence/Verification owner with independently authenticated adapter | `verifyCriterion, bindRevision, finalizeRun`; no child self-approval | JC-RES-018 |
| RC2.4 file-conflict safety | file watchers/handler + Rust guard revision preconditions | authenticated `recordObservedTouch, listForPath, invalidateGeneration`; internal-only `evictExpired`; bind Session/owner epoch/source generation; hard write lease/hash validation separate | JC-RES-011/012.K |
| RC3.1 Provider Doctor | existing selected provider/auth/catalog source; §37.18 | `inspectOffline, probeCatalog, probeFull` with authenticated grant ownership/epoch, consent and actual token/billing evidence | JC-RES-013/014/015/012.L |
| RC3.2 context+recall | ContextLedger/indexd and selected model provider | `compileContext, recallScoped, getTokenBudget, invalidateSourceEpoch` | JC-RES-003/005/020 |
| RC3.3 session import | canonical host Session and explicit native backend adapter | `detectSources, previewImport, commitImport, detachExternalSession` | JC-RES-019 |
| RC4 TUI | hydrated existing renderer + UiEventMux | `normalizePaintEvent, stablePrefixDiff, coalesceReplaceableDelta, chooseFrameDeadline, paintChangedCells` | JC-RES-016/017 |
| RC4 surfaces | existing Settings FeatureExposure and API/TUI/app | `resolveEffectiveFeature, renderResourcePanel, renderProviderDoctor, showFileConflict` | FEAT-001..014 + resource suites |
| RC5 clients | existing public Session/API and authenticated backend adapters | `attachClient, subscribe/ack/replay, sendUserInput, steer, cancel` | replay/auth/single-owner/turn-epoch tests |
| RC5 dev canary/packaging | supervised build/test worker, release owner | `prepareCandidate, testAndAttest, requestUserApproval, activateCanary, rollback` | isolation/signature/rollback and disk/build cases |

**Definition of executable specification before marking a checkbox:** every selected function above has an existing/new concrete file path *in a hydrated checkout*, typed parameters/return/limits, ownership of durable vs derived data, error-code mapping, explicit concurrent/cancel/crash behaviour and a complete test with fixture bytes and method. §37 pseudotypes are not compiled/generated contracts: RC0–5 may be marked CODE_PRESENT only after actual modules/schema appear, WIRED only after real ingress/egress, VERIFIED only after security/OS/performance tests. Benchmarks from JCode or README screenshots are not runtime proofs.

**First coding sequence:** P1.3 requires the host-scoped `hz-kernel` prerequisite in §§14/37; then close the first shell/process origin with complete-batch Guard admission and a real guarded replacement. RC0's read-only ResourceSampler may proceed in parallel only for stable Rust-owned process/lease identities. “Do not build the shared effect daemon first” means do not prebuild the proposed multi-Session observer/virtual-session broker; it does not defer or replace the normative host-scoped effects owner, and it does not permit routing effects through `session_supervisor`. Keep native Windows unsupported paths unavailable until native Windows source/OS tests pass. Follow `AGENTS.md` worktree/cleanup discipline.

## Missing accepted journey implementation ledger — ACP / visual / deployment (2026-10-15)

These flows were already accepted in §§3.16–3.18; prior implementation-specific resource hardening did not fully cover their host interfaces. They are **unchecked** until actual source/contract/system proof exists.

- [ ] **ACP outbound adapter (P6):** hydrate upstream OpenCode ACP server for source reuse, then add distinct Horizon client adapter through existing AgentProfile/DelegationMailbox and Rust worker/Guard. Implement version/auth/capabilities/session link, tool mediation, typed result, cancel/reconnect and UNKNOWN with tests ACP-001..008. Native OpenCode mode remains a separately owned backend, not a second direct Horizon Session writer. *(Superseded for V1 by the 2026-10-16 scope decision and `DEC-V1-24`: external ACP client integration is post-V1; retain this design and ACP-001..008 as the promotion plan.)*
- [ ] **Visual source selection (P5/P7):** browser/preview observation + build/source-map generation → bounded source candidates/ambiguity → approved guarded `files.patch` → re-observe/verification. Real VIS-001..004; do not turn a pixel or untrusted DOM into write authority.
- [ ] **Deployment (P5/P9):** provider/environment/account discovery and deterministic artifact manifest; explicit spend/secret/effect consent; Guard PREPARED/lease; target-side idempotency+receipts; real URL/revision health and critical workflow check; bounded rollback/reconciliation. Real DEP-001..008; no speculative production deployment or success from an upload alone.
- [ ] Add versioned generated machine contracts + canonical §33.30 candidate registrations and actual entry points before marking any new tool WIRED, and update HANDOFF with CI/OS/provenance. Source seam §20.13, safety §14.18, interfaces §§37.20–21, tests §32.35. The existing P1 universal Guard is a prerequisite for effectful routes; do not invent a second execution engine.

## 2026-10-16 — user-directed next-agent execution wave

This records the requested delegation method; it does not change P0–P9 dependencies, mark a gate complete, or authorize effectful work ahead of P1.3.

- Main agent owns architecture/source research and integration. Read the active owner docs and inspect the local pinned OpenCode tree plus the exact OMP/OpenCode revisions in §42 before coding. Prefer compatible source reuse or bounded algorithm adaptation over a fresh parallel implementation; inspect callees, tests, per-file licenses, exceptions and dependency closure, then record any port in §42.
- Use separate bounded agents for P0, P1.2, P3, P4 and P5; one agent owns P1.3 followed by P2, sequentially. P2 starts only after the P1.2/P1.3 entry gates pass. Keep writable file sets non-overlapping and preserve all pre-existing dirty/untracked files.
- P3/P4/P5 may research or implement compatible non-effectful paths in parallel, but every effectful origin remains unavailable until the canonical Guard/ExecutionHost boundary and its negative/recovery tests pass.
- The user explicitly authorized native Windows testing under `/mnt/c/users/sonali/desktop/` in a newly created temporary directory with a child `hzcode` folder. PowerShell 5.1.26100.9711 is available and the Desktop path exists. No such test directory was created in this continuation; keep Windows results separate from WSL/Linux evidence.
- Current implementation status and exact verification remain in `HANDOFF.md`; chronological changes and next steps remain in root `CURRENT_RUN.md`.

## 2026-10-16 — V1 scope decision (revised by user) — Linux-first CLI/TUI with source-adapted capabilities

**Scope boundary only: no gate is marked complete and the fail-closed rule stands.** The detailed V1 goal/status/source map is `implementationtov1release.md`; architecture authority remains the exact topic owners in `arch_V1/README.md`.

**Platform and surface:** V1 targets Linux/WSL-first **CLI/TUI**. Native Windows stays truthfully **UNAVAILABLE** until native acceptance. Web app, desktop app, browser automation/attached-browser and desktop/computer control are post-V1; built-in web search is V1 per the 2026-10-18 promotion (`DEC-V1-26`). Browser-based visual editing, deployment journeys and external ACP client integration remain post-V1; local Rust-owned subagents/workers remain V1.

**V1 finish list (must complete):**
- **A1–A4** — pass the product-level `bun run horizoncode:typecheck` (covering the CLI host, TUI, and Core) → rerun `scripts/architecture/run_push_gate.sh` → push `main` after exact-scope verification → restore Git visibility of hidden first-party files. `packages/opencode` remains an internal source path during the staged naming migration. Nothing ships while the gate is red or commits are unpublished.
- **C13, C14, C15** — guarded shell/process origin, command interpolation, Task/subagent origin. The coding-agent mutations; without them "safe coding agent" is false.
- **C16–C18, C10** — close remaining effect origins (plugins/MCP/hooks, hosted tools, legacy routes) by **mediate-or-disable** with zero-spawn negative tests proving no bypass; full mediation only if capacity allows.
- **C20, C21** — Guard generalization (complete batch/lease/receipt/UNKNOWN settlement) + ToolBatch bounds. Makes the Guard story uniform.
- **C25 (trimmed)** — adversarial matrix limited to origins that are actually enabled. The security claim's evidence.
- **D1, D2, D4–D8, D11 (+ D9-minimal, H7)** — P2 single managed vertical: SpecVersion → one Task/Attempt → one guarded action → receipt → independent verifier; pause/cancel/restart/UNKNOWN and fault tests; API/TUI entry point + Goal review/accept. One Attempt, no fan-out yet.
- **K1, K2-honest, K5, K6** — license/notices, declared platform matrix (Linux/WSL supported; Windows truthfully unavailable), clean install, release gates. Legal + installability are irreducible.
- **S1** — question/`question.ask` catalog + schema + live acceptance (user-flagged).
- **S3** — final-head CI, full gate, DOC guards. The release evidence itself.
- **Expanded V1 capabilities:** LSP, DAP, bounded REPL, OMP-preferred provider/settings/TUI UX, broad tested providers, streaming/rendering, artifacts/analytics/Rust-owned automations, bounded worktree/resource pools, quotas, cross-model suites, worker/subagent DAG, file conflicts, Provider Doctor, session import, bounded caches/local memory, TUI performance and measured JCode-informed RAM/resource optimization. Full goal/status/source mapping and evidence criteria are in `implementationtov1release.md`.
- **RC0 measurement is required V1 work:** capture reproducible 1/5/10/20-session resource baselines and verify measured optimization without correctness/security regressions. **Optional:** RC0.3 cache/renderer baseline capture (bounded cache behavior itself remains a V1 goal) and C22 Linux PTY process-tree cleanup guarantee.

**Post-V1 deferral (keep unavailable, never fake-enable):** web/desktop application surfaces; browser automation/attached-browser and desktop/computer control; external ACP client, visual source-edit and deployment journeys; native Windows acceptance; remote/cloud continuation; shared live collaboration; autonomous self-improvement; broad voice/media and hosted image generation; full product/package/build naming migration; updater and other explicitly deferred platform features. (Built-in web search was removed from this list on 2026-10-18 — it is V1 per `DEC-V1-26`.)

**V1 source-intake method (user directive 2026-10-16):** do **not** rebuild compatible capabilities from scratch without first checking the pinned references. Source clones and exact pins are recorded in `repo_take/NOTES.md` and §42. Use OMP first for compatible provider implementations and CLI/TUI settings/visual patterns; inspect both pinned OpenCode and OMP for LSP/DAP/REPL; use the documented, version-appropriate official OpenCode API/SDK only for explicitly selected OpenCode-owned sessions. Claude Code is behavior reference only; no source reuse. Every port still requires exact file/callee/test, license/dependency, and `REUSE EXISTING / ADAPT ALGORITHM / ADAPTER / REJECT` review; preserve Horizon owner/Guard and test locally. New adapted first-party modules use HorizonCode naming while preserving notices and genuine dependency IDs. Never replace the tracked `opencode/` snapshot with a clean upstream checkout.

**Dependency order and evidence:** P1.3 Guard precedes effectful feature exposure. Then prove one managed Attempt and an independent final-revision verifier before expanding worker/DAG fan-out. RC0 measurement can proceed independently on stable owner identities. The main agent owns integration and status changes; keep at most one heavyweight Rust build active. Scope does not promote implementation status.

## Design-hole closure assignments — 2026-10-18 (user-directed)

Recorded from the design-level audit (`CURRENT_RUN.md` §8; gates in `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.4). No gate below is claimed complete.

- **OS-confinement backend (`horizoncode-sandbox`) — P1.** The backend is present and source-wired through HostKernel terminal/stdio confined preflight and dispatch (`terminal_process.rs`, `host_kernel.rs`; source review 2026-10-19). This does not yet establish the final product containment matrix or no-bypass/denial acceptance. Linux target: bubblewrap namespaces + Landlock/seccomp-class restrictions + scoped roots (pinned `repos/codex` research: `codex-rs/linux-sandbox` bwrap+landlock, `codex-rs/network-proxy`; §42 provenance/license review). Required evidence remains per-kernel containment plus LS-009 / DAP-002 / REPL-001 / PS-003 denial tests. Keep any unproven origin unavailable until its actual dispatched process is shown confined.
- **Checkpoint/rewind — LLD closed 2026-10-18 (§14.19, §16.18, §31.18); wiring P7 (session/artifact surface) with P8 recovery acceptance.** V1 reliability criterion §32.24; tests CP-001/CP-002; core seam `packages/opencode/src/session/revert.ts`; gate `DEC-V1-25`.
- **HorizonCode-as-MCP-server exposure — post-V1 (`DEC-V1-23`).** Verified 2026-10-18: the pinned Codex source is MCP-client only (spawned MCP server processes are sandboxed) and the current Claude Code CLI reference has no `mcp serve`; both ship structured headless surfaces instead (Codex `app-server`/`exec-server`; Horizon `run`/`serve`/future SDK). Real parity item: spawned stdio MCP server processes must run through P1.3 Guard/ExecutionHost confinement (§14.6).
- **Editor/IDE integration breadth — post-V1 (`DEC-V1-24`).** V1 is CLI/TUI only; external ACP client stays post-V1 (design §37.20 retained; tests ACP-001..008); VS Code/JetBrains-class extensions are undesigned and unclaimed.
- **Built-in web search — promoted into V1 (user directive 2026-10-18, `DEC-V1-26`).** Design: §33.9 `web.search.*`; §37.5 WebSearchBrokerV1; §16.7/§16.15 settings; `DEC-V1-20` cost/auth/reliability matrix; acceptance in §32 and Gate 6. Model: built-in default route + optional BYO-key providers (Brave, Exa, …); enabled routes form one ordered cascade with fail-through; exhausted chain → one bounded normal retry + per-route reasons; no route used unless enabled; no hidden paid fallback. Research packet (competitor behavior + provider matrix) in flight; implementation follows design sign-off.

## Web-search V1 promotion — 2026-10-18 (user-directed)

Built-in web search was promoted from post-V1 into V1 by direct user instruction (`DEC-V1-26`). No gate is claimed complete.

- **Design owners updated in the same pass:** `arch_V1/33` §33.9 (V1 label + cascade contract), `arch_V1/37` §37.5 (route configuration/cascade/settings/provenance contract), `arch_V1/16` §16.7 (web search connections in Settings), `arch_V1/14` §14.16 + `arch_V1/15` §15.12 (effect classification + fallback semantics), `arch_V1/17` §17.4 (`DEC-V1-26` added; `DEC-V1-20` amended) + §17.11 amendment, `arch_V1/32` acceptance bullets, `arch_V1/10` §10.7, `arch_V1/01` scope note.
- **Research (competitor/provider packet completed 2026-10-18; tool-suite study still running):** competitor behavior (Cline, Codex, OpenCode, Claude Code, others) + provider landscape — recommended built-in keyless chain Exa → You.com → Tavily → Firecrawl → Parallel → TinyFish; BYO-key set Exa/Tavily/Brave/Parallel/You.com/Firecrawl (+ tier 2 Kagi/Jina/Linkup/Serper); Google CSE/Bing/DuckDuckGo excluded; SearXNG deferred post-V1; 429-only failover with Retry-After cooldown; no auto keyless→paid upgrade. Matrix seed recorded in §37.5. Tool-suite upgrade study (Desktop Commander, Playwright MCP, Context7, DeepWiki) mapped to §33 IDs still running.
- **Implementation workstream (P5-WS, queued):** source-adapt the typed provider routing from the pinned OMP reference (§42 SRC-007; `repo_take/oh-my-pi/packages/coding-agent/src/web/search/`) under the §37.5 contract, after P1-ORIG frees `packages/opencode/src/tool/websearch.ts`; Settings wiring, cascade tests and acceptance evidence follow.

## VEO-inspired roadmap review — 2026-10-19 (design proposal only)

The user supplied `C:\Users\Sonali\Downloads\extra_some_Stuff.md` for critical review. The full 1,851-line note was compared with the pinned product source, current competitor documentation and the active architecture owners. The selected mechanisms are now refinements to the existing required V1 phases under A-V2-33; system HLD, owner-level flows, event projections, schemas/LLD and tests are recorded in `arch_V1/01`, `/03`, `/04`, `/12`, `/29`, `/30`, `/31`, `/32` and `/37`. The initial decision analysis is in `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md`.

Required V1 allocation: P1 owns authenticated Guarded delegation/effect scope; P2 owns the one accepted-SpecVersion/Task/Attempt vertical, typed evidence and independent final-revision verification; P3 owns bounded generation-bound RepoIntel navigation and stale-write rejection; P6 owns provider/cache/cost truth and reviewed skill trust; P7 owns evidence artifacts and replay-safe UI/analytics projections; P8 owns attributed reservations and recovery. P4, P5 and P9 retain their existing scope. The dependency edges remain P1 → P2 effect dispatch, P7 ArtifactStore → P2 verifier evidence, P2 → P8 fan-out; P3/P6/P7 independent preparation continues in parallel. Effectful dependent paths stay unavailable until the corresponding upstream acceptance passes.

VEO-F1..F8 remain optional post-V1 extensions (including broader mutation campaigns, visual verification and staging/production integrations), not extra release phases or V1 blockers. P2 now owns the canonical private IPC `delegation-binding-v1` schema and golden fixture under `arch_V1/contracts-v2/`; managed admission denies before preparation when accepted trusted binding fields or live leases are unavailable. P7 lifecycle labels are projections over existing owner streams/cursors, not new OwnerLog kinds or an event bus. The remaining RepoIntel, evidence and event wire shapes must be reconciled with their owning schemas, generated bindings and fixtures before cross-process wiring. The review does not authorize another runtime, event bus, index, effect authority, hidden provider fallback or autonomous production changes. The full phase-to-owner/evidence matrix is maintained in `implementationtov1release.md`.


## 2026-10-19 15:52 UTC — live execution checkpoint and implementation-first hold

This checkpoint reconciles the operative phase queue with the current whole-phase roster. The user explicitly directed implementation before tests/builds; historical test reports remain preliminary and do not authorize a verification wave until source implementation for the requested V1 scope closes. Do not enable a dependent effect because its source or interface exists.

| Phase | Live owner/state | Remaining implementation before verification |
|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | Finish universal pre-dispatch Guard and OS confinement, shell/process/interpolation and authenticated child effects, enabled-origin mediate-or-disable closure, atomic bounded ToolBatch leases/receipts/UNKNOWN/cancel/restart. Keep unsupported origins disabled. |
| P2 managed vertical | Active whole-phase owner | Finish distinct authenticated reviewer, accepted plan-to-Task/Attempt path, exact Attempt/effect/lease receipts, guarded independent verifier output/artifact and fresh current-workspace evidence, Core-to-TUI delivery, pause/cancel/restart/UNKNOWN/stale/conflict recovery. Finalization remains disabled. |
| P4 LSP/DAP/REPL | Active whole-phase owner | Finish supervised lifecycles, production editor ingress, mediated LSP edits/rename, DAP attach/evaluate, REPL callbacks/recovery and Linux real-project journeys. All effectful dispatch waits on P1 Guard/confinement. |
| P8 resources/workers/RC0 | Next queued whole-phase owner when a real slot opens | Complete HostKernel worker/worktree lifecycle integration, guarded worktree operations, resource/process attribution and recovery; keep fan-out disabled until P1/P2 prerequisites. Required 1/5/10/20 baselines remain for the later verification stage. |
| P7 streaming/artifacts/analytics/automation/rewind | Partial, queued | Complete cursor/emitter/SDK parity, redaction/render interactions, truthful artifact fidelity, P8-backed automation/checkpoint/rewind and replay/resnapshot journeys. |
| P3 RepoIntel | Partial, queued | Complete a real authenticated source/parser producer, bounded structural results/pages, stale-write rejection and recovery; preserve honest unavailable results where unsupported. |
| P5 built-in web search | Partial, queued | Complete built-in default plus user-enabled ordered cascade, route auth/cost/status provenance, bounded retry/cooldown/failure reporting, Settings consent and Guarded transport. Never silently upgrade to paid routes. |
| P6 providers/settings/Doctor/S1 | Partial, queued | Complete guarded credential writes/provider binding, Doctor tiers, FEAT-001..014 and provider/model switching; later perform the explicitly authorized free-model acceptance after implementation. |
| P9 and integrated release | Partial, queued | Finish Linux CLI/TUI packaging/install/license and Git visibility work; after implementation closes run final-revision typecheck, tests, security/platform/release gates and exact-scope publication. |

P1/P2's current private interface is `ManagedAttemptScopeV1` with Goal/Run/Task/Attempt IDs, canonical-decimal owner epoch/revision, authenticated Location/Session, workspace revision digest and Rust-owned delegation-binding digest. Each effect remains separately bound to its exact effect ID, OwnerLog revision, capability and one-use lease digest. P1/P2 agree verifier observations must bind the same live Attempt plus exact criterion effect IDs and the HostKernel's freshly observed workspace revision. P4's Location/workspace pins are distinct from process generation, owner epoch and REPL source generation. The verifier remains disabled until its actual guarded dispatch and durable receipt path exists. Corresponding normative flow/schema/runtime contracts are in arch_V1 §§3.22, 12.19 and 37.22; observed phase state is in `implementationtov1release.md` and `HANDOFF.md`.

At this checkpoint P1/P2/P4 occupy all three available child slots; P8 is next on slot release. C: `/mnt/c` had 20 GB free (96% used), `kernel/target` 2.7 GB and `indexd/target` 292 MB; only the main worktree is present. The shared tree is mixed staged/unstaged/untracked and `main` is 12 commits ahead. Preserve all existing ownership; no stage/commit/push/cleanup/prune. Overall V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 15:53 UTC — P1/P2 source delta (not acceptance)

P1 source-wired exact managed terminal-effect receipt recording from HostKernel, with durable Attempt/principal/epoch/Location/Session/effect/revision/lease/target-receipt/workspace-revision bindings; unresolved outcomes remain UNKNOWN and no-relaunch. P1 added host-derived Attempt and per-criterion effect IDs to verifier journal/observation records. P2 tightened coding/verifier principal matching and requires every coding receipt to succeed at the pinned source revision before verifier intent; the verifier must preserve that revision. The legacy HostKernel verifier call sequence remains incompatible, so verifier dispatch and finalization remain disabled. No build/test evidence exists for this delta. Keep the remaining phase implementation queue in the 15:52 checkpoint above and the main status matrix in `implementationtov1release.md`; release remains PARTIAL / NOT RELEASED.

### 2026-10-19 15:56 UTC — managed revision-chain integration checkpoint

The HostKernel source derives a live managed Attempt workspace head from immutable Attempt admission provenance and the ordered predecessor-linked SUCCEEDED receipt chain, then checks the registered workspace root. The aggregate OwnerLog revision is distinct from each effect edge's bound revision. Source review found `ManagedControl::RecordAttemptEffectReceipt` still compared each coding receipt to the original Attempt base; P2 acknowledged the gap and is implementing the reducer's independent ordered-chain validation with P1. This is an integration blocker: verifier dispatch/finalization remain disabled until HostKernel and reducer enforce the same chain, including read-only verifier before=after=head and no caller-supplied rebase. Normative detail is now in arch_V1 §§3.22, 12.19, 14.3 and 37.22. P1/P2/P4 are still active phase owners; no tests/builds/typechecks are allowed yet under the implementation-first instruction. V1 remains PARTIAL / NOT RELEASED; remaining phase work and final verification/release gates remain as listed in the 15:52 matrix above.

### 2026-10-19 15:57 UTC — Guard lease/managed intent revision cycle resolved

Persist the Attempt edge and immutable verifier intent (trusted profile/executable, criterion, arguments and current workspace head) before Guard lease issuance; the durable intent does not contain the one-use lease digest. Refresh ManagedAttemptScope to the post-intent OwnerLog revision, then Guard/approval binds a one-use lease to the exact edge, immutable intent digest and live revision/workspace fence. EffectHost owns durable one-use consumption; the HostKernel-authenticated settled receipt records the exact lease digest. Authenticated distinct reviewer approves; trusted verifier profile principal owns the supervised child and receipt. An OwnerLog/workspace change while approval is pending invalidates authorization. This resolves the discovered revision cycle under §14.3 and is recorded in §§3.22/12.19/14.3/37.22. P1/P2 remain responsible for wiring and managed reducer chain validation; P4 keeps DAP unavailable until a correctly typed supervised process ref exists. No tests/builds/typechecks; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 18:01 UTC — source audit and owner stop reconciliation

The user stopped all subagents; the live roster is empty and this supersedes prior active-owner checkpoint rows. The user-directed implementation-first hold remains: do not run tests/builds/typechecks/audits/provider probes until implementation scope closes. Local HorizonCode CLI-host package and Codex tree inventories and phase-level source decisions are recorded in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` §42.12. No upstream source was copied. The working tree remains mixed staged/unstaged/untracked on `main` 12 ahead; C: has 60 GB free. V1 remains PARTIAL / NOT RELEASED. Resume from actual source and the complete V1 phase matrix, not the historical owner roster; preserve all existing changes and do not stage/commit/push/clean/prune while exact ownership is ambiguous.
## 2026-10-19 18:26 UTC — source-led architecture re-audit checkpoint

This is a progress checkpoint inside the full V1 target, not a phase completion. The user
directed that all subagents stop, so no implementation owner is active; do not restart agents
under that instruction. Keep the implementation-first hold: no tests/builds/typechecks/audits
or provider probes until implementation closes.

Source inspection compared OpenCode's direct Task/child Session behavior with Codex's
root-owned agent-tree lifecycle (spawn reservation, parent-policy config snapshot, lineage,
safe-boundary mailbox, send/follow-up distinction, wait, interrupt/cancel, terminal result,
resume ownership and residency). A mismatch was found between §03.5's managed-only wording
and the no-Goal direct-session delegation allowed elsewhere. §§03.5, 29.5, 37.9 and derived
§45.8 now describe separate direct Core Session and managed Rust Task/Attempt lanes; §42.12
records exact source findings and adaptation boundaries.

Open contract choice: `SubagentDeliveryV1` currently lacks a direct/managed lane discriminator
and leaves `authorityDigest` undefined. User was asked to select a single lane-tagged envelope
or separate schemas. Do not change that contract until the answer arrives. The remaining
architecture/source audit still spans the V1 modules and all active `arch_V1` topic owners;
implementation and release requirements remain those in this plan and the latest HANDOFF.
### 2026-10-19 18:28 UTC — sandbox resource-limit source gap

The Linux `horizoncode-sandbox` source reports OS `ResourceLimits` unsupported; current
terminal/non-PTY launch paths require filesystem, network-denial and process-tree guarantees
but not CPU/memory/process-count quotas. Admission, sampling, deadlines and output caps do
not prove OS enforcement. §14.5 records the finding.

### 2026-10-19 — resolved delivery, resource and search-failover decisions

- `SubagentDeliveryV1` is one lane-tagged envelope: direct Core delivery binds parent/child
  Session plus trusted profile revision and effective permission-scope digest; managed
  delivery binds the exact Rust `DelegationBindingV1` digest and Goal/Run/Task/Attempt IDs.
  `authorityDigest` is domain-separated BLAKE3 over canonical MessagePack including the
  domain tag, lane, parent/child execution IDs, owner epoch and validated authority claims; it is
  recomputed by the trusted owner; it never grants authority. A browser-safe TypeScript
  decoder is source-present at `packages/schema/src/subagent-delivery-v1.ts` but is not yet
  typechecked or wired into Rust/Core dispatch; Rust parity and a shared golden fixture remain.
- OS CPU/memory/process-count/FD guarantees stay unavailable until the selected backend
  enforces them. Profiles requiring them fail before launch. Admission/monitoring is allowed
  only for actual bounded/observed dimensions and cannot be advertised as hard OS quotas.
- Built-in web search records auth 401/403/407 per-route failures and continues only through
  explicitly enabled/configured routes. Other non-rate-limit 4xx stop and surface. The
  production Guard gate remains closed until P1's dispatch/security prerequisites pass.
- The user-directed implementation-first hold remains active: do not run tests/builds/
  typechecks/audits/provider probes until all requested implementation work closes. The user
  stopped subagents; do not restart them. §04 additionally records lane-bound child progress
  and redacted search-route attempt projections, with replay/resnapshot forbidden from
  reissuing a request. Trackers remain PARTIAL / NOT RELEASED.

### 2026-10-19 — SubagentDeliveryV1 decoder source delta

Rust strict MessagePack decoding and authority-digest recomputation are now source-present in
`kernel/src/subagent_delivery.rs`, alongside the browser-safe TypeScript decoder. The Rust
module is not wired to a delivery RPC or direct/managed Task lifecycle. Cross-language golden
fixtures, tests, runtime integration, current-revision verification and all V1 phase gates
remain open. No test/build/typecheck/audit was run under the user's implementation-first hold.

### 2026-10-19 — P2 reviewer-path source reconciliation

Current source includes middleware-derived `ServerAuth` transport through the authenticated
Core→HostKernel private request and durable distinct SpecVersion reviewer assignment/decision
checks. This corrects the earlier checkpoint that treated the production reviewer channel as
absent. The real-socket positive path and forged-identity negatives remain unverified; P2's
reviewer requirement is CODE_PRESENT/WIRED at source level, not TESTED/VERIFIED.

### 2026-10-19 — direct Task profile authority resolution

Core Config's immutable `AgentProfileV2` revision is authoritative for both direct-session and
managed child profiles. Core Config owns an explicit `agent_profile_selectors` mapping
`{selector, profileId, revision}`; TaskTool resolves only that exact immutable target. Profile
display names and legacy `Agent` names are not implicit aliases; duplicates, stale mappings,
wrong-owner profiles and missing revisions fail closed. A profile update never silently moves
an existing selector. A child resumes only its Session-pinned revision. Legacy `Agent` config
is migration input and cannot issue child authority. The resolved V2 profile must drive the
actual child model, harness, instructions, tool exposure and effective
parent-intersected permission scope before its revision/digests are pinned to the child Session
and Direct Attempt. Resume must recover that exact revision or fail closed. No decorative V2
digest over legacy runtime values, unpinned parent-model inheritance or silent latest-profile
substitution. P1/P2 own the direct integration boundary; implement source-only until the user's
implementation-first hold is lifted. `VEO-017` is the required stale/mismatch/recovery test.

Product-wide TypeScript status is always referred to as HorizonCode `bun run
horizoncode:typecheck`. A package-scoped result is a HorizonCode TypeScript package check with
its package path (for example, `packages/opencode`); it is not labeled an OpenCode product
typecheck.

### 2026-10-19 19:18 UTC — P3/P4 authenticated read and process profile contract

P1 source now includes the additive bounded `repo-intel.v1/read_document` operation; P4
LSP reads only through the injected HostKernel adapter. The existing RepoIntel service,
RepoRead context, registered Location binding and Guard `files.read` remain authoritative.
Contract/schema and RD-017/LS-011 acceptance are updated in §§12.18/17/30/32/37. P1 is
adding source coverage; no tests were run.

The user-approved Core Config→HostKernel launch profile is fully specified at §12.20 and
`contracts-v2/execution-launch-profile-v1.schema.json`. It carries immutable ID/revision,
kind, configured executable selector, literal argv, fixed Location-root cwd and sanitized
environment policy. No interpolation or caller-supplied process fields are accepted. P1
owns typed `execution.v1` prepare/launch/read/write/cancel/status and HostProcessRef/receipt
integration; P2 owns managed intent/reducer and Core/TUI contracts; P4 owns client lifecycle.
Managed verifier, P4 process launch, DAP debuggee effects and REPL remain unavailable until
their respective P1 Guard/confinement/resource prerequisites pass. Whole-phase owners P1,
P2 and P4 are active; P3/P5/P6/P7/P8/P9 await available slots. The implementation-first
hold remains in force; V1 is PARTIAL / NOT RELEASED.

### 2026-10-19 19:38 UTC — active source continuation

The user confirmed the existing trusted Core Config as the immutable LSP/DAP launch-profile
source projected into HostKernel and run through the existing single ExecutionHost supervisor.
P1/P2/P4 are the three active whole-phase owners; P7 is next on actual slot release. P2 now
resolves explicit Core Config selectors to AgentProfileV2 for direct Task child admission and
is extending the same live coding Attempt through verifier effect receipts, typed evidence
and settlement. P2's latest source preserves/resumes only the same active Attempt for a
durable VERIFYING Run when exact verifier, receipt-chain/current-head and no-prior-verifier-
intent/evidence conditions hold; it does not renew the Attempt epoch. P1 must still revalidate
the live lease and recover the exact challenge journal before verifier dispatch.

P1 source reconciles durable direct-profile capacity at HostKernel startup: only a provably
pre-admission missing/empty owner record is abandoned; persisted reservation authority fields
must match the direct Attempt record; mismatch fails startup closed; terminal release is
replayed, while EXECUTING/UNKNOWN stay reserved. The strict execution protocol page decoder
rejects sequence gaps. HostKernel now has typed `protocol_op`, `protocol_read`, and
`protocol_reply` routes that validate process and Attempt scope, workspace revision, and Guard
challenge/lease; each intentionally returns `capability_unavailable` before IO because the
durable operation receipt journal and replay event buffer are not yet implemented, so leases
are not consumed. P4 is aligning its typed client to contiguous replay and fail-closed
quarantine semantics. P1 has now closed the code-mode MCP bypass in source: nested `callTool`
dispatch is removed/denied, the `execute` tool is not registered even when the experimental
flag is enabled, and a fake-client zero-dispatch regression is added but unrun. No
tests/builds/typechecks/audits/probes/performance runs are to start before V1 implementation
source closes. All phases and final release remain PARTIAL / NOT RELEASED. Git ownership
remains mixed; one worktree; C: `/mnt/c` has 60 GB free.

### 2026-10-19 19:43 UTC — process receipt and verifier restart integration

The user's launch profile source is trusted existing Core Config projected into HostKernel and
run only by the existing ExecutionHost supervisor. §37.6 now defines the typed
`protocol_op`/`protocol_reply` receipt ACK: exact process ref, canonical request sequence,
separate IO sequence, operation and receipt digests, durable intent before lease/write, and
durable terminal receipt before acknowledgment. Ambiguous/partial dispatch is UNKNOWN with no
replay. Inbound event sequencing is separate and contiguous. P1/P4 keep these routes unavailable
until the journal and event replay implementation land.

P2 narrowed same-Attempt VERIFYING restart after P1 showed that the current execution receipt
does not retain output bytes or ArtifactRefs: safe preservation is limited to pre-verifier
dispatch at the exact frozen revision, or settlement from already durable typed evidence and
matching artifact/receipt pins. A possible-dispatch crash before evidence stays UNKNOWN with no
redispatch. VEO-018/§37.22 record the artifact durability requirement. No validation runs before
all V1 source implementation closes.

P1 source review additionally found the current HostKernel managed verifier begin/execute
handlers are not wired to P2's Attempt-bound effect/intent/receipt reducer APIs; the broker
authorization has an empty Session and no Attempt scope. P1 owns HostKernel integration and P2
owns the reducer/API. Keep verifier execution unavailable until authenticated Session/Location,
exact Attempt/effect, owner-epoch, current-workspace, reviewer, Guard lease and durable receipt /
evidence bindings cross this boundary.

Parent added the exact receipt machine schema under
`arch_V1/contracts-v2/execution-protocol-receipt-v1.schema.json` and defined canonical
MessagePack digest preimages in §37.6. DAP `threads` uses the existing scoped read-only
`debug.stack` capability; `variables` stays unavailable without adapter-specific passive-read
proof. HostKernel must reject stale persisted Attempt owner epochs before resume and preserve
CANCELLING. P4 replaces the stale raw-child LSP test and adds typed DAP fixtures as source only;
the implementation-first hold still forbids running them.

### 2026-10-19 19:51 UTC — current source continuation

The user confirmed the trusted Core Config→HostKernel LSP/DAP launch-profile projection
through the existing single ExecutionHost supervisor. P1/P2/P4 remain the active whole-phase
owners; P7 is next only when a child slot opens. P1 source now connects HostKernel verifier
operations to P2's Attempt-scoped intent/receipt/evidence reducer calls and stale-epoch
rejection, but `TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false. Terminal verifier
output/ArtifactRef reconstruction after possible dispatch is missing and must remain UNKNOWN
without replay. Protocol IO still returns unavailable before write/read until its durable
dispatch journal and event replay buffer are complete.

P1 added canonical protocol operation/dispatch-receipt digest helpers and strict ACK parsing,
but durable journaling, supervisor IO, receipt-before-ACK and replay remain unimplemented.
P4 added typed no-effect LSP/DAP fixtures and Core-side journals for outbound sequence,
receipt/process-IO comparison, response correlation, replay suppression and conflict
quarantine; HostKernel protocol IO and process effects remain unavailable. P2 added a
revision-fenced Goal Run control route, SDK operation and TUI `goal.control` confirmation
path that returns the displayed Goal revision and rejects stale views before CAS. No
test/build/typecheck/audit or provider/performance command may run before all V1 source
implementation is complete. Git ownership remains mixed; keep it unchanged. V1 and every
phase remain PARTIAL / NOT RELEASED.

### 2026-10-19 19:53 UTC — source-only settlement/control update

P1 now source-wires managed verifier evidence followed by exact live-Attempt settlement from
the OwnerLog receipt digest. Workspace drift persists terminal receipts before setting
UNKNOWN. The verifier kill switch remains false. Recovery must reconcile a crash after OwnerLog
settlement but before verifier-journal SETTLED from durable OwnerLog only; a pre-evidence or
pre-artifact crash remains UNKNOWN/no redispatch.

P2's `goal.control` TUI flow now loads the authenticated snapshot and current Run, displays the
Goal revision, sends `expectedRevision`, and consumes a bounded Run status projection. The
server rejects stale view revisions before OwnerLog CAS. Source-only regressions were added,
not run. Implementation-first hold remains; all phases and release remain PARTIAL / NOT
RELEASED.

Parent source review found `managed_execute_verification` returns `VERIFIED` unconditionally,
although the reducer sets RunPhase::Failed when any criterion verdict is FAIL. P1 owns deriving
the response from the durable Run state and adding a source regression. This is an open source
finding; the verifier adapter is disabled and no validation ran.

P4 source additionally validates DAP event-page Attempt/process/workspace scope and event/byte
bounds, advances the process IO pin, rejects skipped cursors, and retains REPL direct Attempt
scope. DAP fixtures are source-only. HostKernel protocol methods remain fail-closed before IO
while P1's durable journal/replay is missing.

Open recovery finding: HostKernel evidence-only recovery omits RunPhase::Cancelling, although
the reducer preserves cancellation during Attempt settlement. P1 owns no-dispatch settlement
reconciliation that preserves CANCELLING; P2 owns truthful response/schema/TUI status. A crash
in this state must not strand durable evidence or trigger redispatch. Source fix pending.

Superseding source update: P1 now reconciles evidence-backed CANCELLING/CANCELLED states,
validates the exact settled receipt digest and maps truthful verifier statuses. A prior epoch is
accepted only for evidence-backed settlement reconciliation; stale unresolved Attempts become
UNKNOWN. P2 still needs TypeScript schema/SDK/TUI cancellation status parity. P1 also applies
JavaScript safe-integer bounds to DAP request IDs. P4 added duplicate-ACK receipt idempotency,
conflict quarantine, bounded receipt history, inbound cursor fencing and event/byte bounds.
HostKernel dispatcher/replay IO remains absent; source-only and unverified.

P2 has aligned the GoalVerification response schema, SDK types and TUI status messages for
CANCELLING/CANCELLED/FAILED with P1's HostKernel status mapping. Source-only, unverified.

### 2026-10-19 20:01 UTC — managed prompt scope and phase ownership

P2 source inspection found no production ManagedAttemptScope entry into Core prompt/ToolBatch:
managed control can plan/admit, but prompt execution accepts only direct Attempt authority. P2
owns the typed scope path in `session/prompt.ts`, `session/managed-control.ts`, and its route/UI
caller. P1 retains exclusive ownership of `session/tool-batch.ts`, Guard client and HostKernel
ingress and will integrate the scope there. The agreed envelope binds Goal/Run/Task/Attempt,
owner epoch, expected managed revision, Location/Session, workspace revision and delegation
binding digest. All caller-provided pins must be checked against authenticated durable state;
the envelope does not confer authority. No effects are enabled by P2 caller plumbing alone.

P1/P2/P4 remain active whole-phase owners in all three available child slots; P7 is next on an
actual slot release, followed by the remaining queued phase owners according to dependencies.
The implementation-first hold remains active. No verification command ran. Git remains mixed on
`main`, 12 ahead, and C: via `/mnt/c` has 60 GB free. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 20:03 UTC — Attempt-bound lease revision cycle closed by contract

P1/P2 found that direct and managed Attempt scope digests include the current aggregate owner
revision, which advances when ToolBatch effect edges are bound. To preserve the exact lease
fence, the normative order is now Guard evaluation and explicit approval → atomic binding of
the complete exact Attempt effect set → HostKernel refreshed-scope/current-state validation →
one-use lease issue bound to refreshed scope plus exact edge/intent. A pre-bind challenge is
provenance only and may transition exactly once before a lease exists; even ALLOW defers lease
issue. No issued lease is mutable and no caller rebase is accepted. VEO-019 covers stale/raced
revision, duplicate bind, cancellation/restart and lost refreshed-scope outcomes. This applies
to direct and managed Attempt effects. Parent recorded the contract in §§14.3, 17.15, 32.38 and
37.22.

P2 reports CODE_PRESENT source for typed ManagedAttemptScope propagation through managed-control,
prompt and LLM, plus bounded atomic `BindAttemptEffects` reducer support. P1 retains exclusive
ToolBatch/`tools.ts` and HostKernel lease integration. No checks ran. Implementation-first hold
and PARTIAL / NOT RELEASED remain.

### 2026-10-19 20:05 UTC — managed admission ownership

P2's source review confirms production HostKernel `managed_admit` still returns
`capability_unavailable`: complete authenticated DelegationBinding/owner proofs are missing.
P1 accepted this HostKernel implementation (including exact Task profile pin and host-issued
managed scope); P2 owns Core/TUI caller and strict projection. Scope propagation through
managed-control/prompt/LLM and the atomic bounded reducer command are CODE_PRESENT, not an
end-to-end path. P1 owns ToolBatch/EffectHost sequencing and the post-bind lease boundary. P2
must obtain a fresh host-issued scope after each OwnerLog mutation. Managed effects remain
disabled; no tests/builds/typechecks have run.

### 2026-10-19 20:07 UTC — P8 prerequisite and P4 adapter source delta

P1 identified that `ManagedDelegationAdmissionFactsV1::from_owner_proofs` requires authenticated
Attempt/profile/context proofs, active parent WorkerExecution lineage, a durable P8 worker
lease and a Guard effective-capability ceiling. The current HostKernel has no producer for the
worker lineage/lease facts, and `open_worker_owner` keeps fan-out closed; P1 will not invent
proof from caller input. P8 is now a direct prerequisite for P1 managed admission/P2's vertical;
P7 artifact APIs remain needed for independent verification. P1 continues its independent
Guard work and will define the host interface needed from the next whole-phase P8 owner.

P4 added method-bounded DAP adapter source and hardened LSP transport sequencing, retained
Attempt scope, response-listener ordering and fail-closed request behavior. Process launch and
REPL effects remain unavailable pending P1 protocol/supervisor/confinement; OS quotas remain a
REPL prerequisite. No validation ran. P1/P2/P4 remain active; P8 and P7 are prioritized for
actual slot releases according to these blockers. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 20:10 UTC — P8 active and managed root-execution contract resolved

The whole-phase P8 worker/resource/worktree owner `p8_worker_resources_full_1019` is active in
one of the three actual child slots alongside P1 (`p1_guard_full_resume`) and P2
(`p2_managed_wave2_1019`). P4 has returned its source-only adapter package and is PARTIAL pending
P1's Guarded supervised process/IO/replay/confinement path and unsupported OS quota boundaries.
P7 is queued for the next real slot because P2's independent verifier requires immutable
ArtifactStore output/evidence APIs.

Parent resolved the missing parent of the first managed Task: `DelegationBindingV1.parentExecutionID`
uses a durable Rust logical root-coordinator `WorkerExecutionId` bound to the authenticated
existing Core Session/Run, OwnerLog and fenced Core transport/process incarnation. It is lineage
for the existing Core coordinator, not a second runtime, transcript or spawned process. The
current Attempt owns its own P8 RESERVED lease; shared Core process measurements are counted
once and no separate root-worker quota is claimed. Nested children continue to require an active
claimed parent WorkerExecution. P8 pins pre-admission Attempt/profile/context/Spec/workspace facts
in the RESERVED lease; P1 atomically persists the binding and lease refs, then P8 attaches the
exact binding digest before claim/dispatch. If identity/incarnation is unavailable, admission
fails closed. This ruling is recorded in arch_V1 §§12.18, 17.16, 29.5, 37.22 and VEO-021.

P2 confirmed its `ManagedAttemptAuthority` helper had no production caller and no actual
prompt/LLM scope propagation. It is now adding the missing generated SDK operation for the
existing `goal.plan` TUI caller and a trusted `promptManaged(input, authority)` entry; it reports
P1 has supplied typed profile/context admission fields and owner-derived scope. This path is
still being wired, not acceptance evidence. P1 and P8 have the root proof/lease sequence and
exclusive file boundary. No tests/builds/typechecks/audits/provider probes/benchmarks ran.
Git remains mixed and untouched; C: via `/mnt/c` last showed 60 GB free. No cleanup/prune.
V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:13 UTC — launch-profile decision and direct receipt dependency

The user confirmed the V1 LSP/DAP launch-profile source: project the existing trusted Core
configuration into HostKernel, resolve the immutable profile there, and execute only through
the existing ExecutionHost supervisor. Do not accept caller-selected executable/argv/process
fields or introduce a second supervisor. P1 owns the authenticated projection and Guarded
launch path; P4's LSP/DAP adapters remain unavailable until the supervisor, confinement and
protocol receipt/replay prerequisites are implemented.

P1's active source review found that Rust `DirectAttemptControl` currently persists admission,
exact effect-intent binding and terminal status, but lacks durable per-effect receipts and
per-receipt workspace-head revisions. This prevents safe direct-child multi-effect dispatch
and scope refresh after workspace mutation. P2 now owns adding the direct Attempt receipt/head
owner-log command with exact effect/intent linkage, replay/conflict handling and UNKNOWN
recovery; P1 owns HostKernel/EffectHost integration, receipt validation, lease sequencing and
fail-closed dispatch. This boundary is source work only; no tests/builds/typechecks/audits ran.

P1, P2 and P8 remain the three active whole-phase owners. P7 is next after an actual slot
release; P3/P5/P6/P9 remain queued. The implementation-first hold remains active. Git state is
mixed and preserved; no stage/commit/push/cleanup was performed. C: via `/mnt/c` has 60 GB free.
V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:13 UTC — pre-approval bind ordering gap

P1 source review found ToolBatch PREPARE currently binds Attempt effect edges before the Core
approval decision, violating the approved lease order. P1 is moving the atomic bind to the
post-approval resolution path (or immediately after an unchallenged Guard ALLOW), retaining the
pre-bind scope only as challenge provenance. The HostKernel must then return the refreshed scope,
revalidate the exact effect set/current workspace and issue a lease against that refreshed scope.
No Attempt mutation occurs before a required approval; retries remain idempotent and stale/cancelled
requests fail closed. Source fix is in progress; no tests or checks have run.


### 2026-10-19 20:14 UTC — approval ordering also covers managed effects

Parent source review found `managed_bind_attempt_effect` accepts `awaiting_approval` and writes
`BindAttemptEffect`, so the same PREPARE-before-approval mutation may exist on the managed
per-effect path. P1 is tracing and correcting both direct batch and managed per-effect callers
under the common §14.3/VEO-019 order: challenge/provenance first, approval if required, complete
exact binding, refreshed scope/revalidation, then one-use lease. Verifier immutable intent
handling must follow its specific contract without mutating the Attempt before approval. This
is an open source finding assigned to P1; no checks ran.


### 2026-10-19 20:40 UTC — user decision and implementation roster

The user chose a distinct authenticated goal.start after accepted SpecVersion. The normative Goal path now keeps goal.plan effect-free, persisting a non-dispatchable PLANNED Run with pinned Tasks; goal.start makes an atomic, revision-fenced, idempotent PLANNED→RUNNING transition and readies dependency roots for the exact accepted SpecVersion/Goal revision. Start alone creates no Attempt/effect authority. P2 owns full Rust/Core/API/SDK/TUI implementation. VEO-023 covers stale/unauthorized/spec-swap/replay/idempotency and no-dispatch cases. Architecture references: §§3.4, 17.18, 32.38, 37.22.

Active whole-phase children: P1 p1_guard_v1_resume_1020; P2 p2_managed_v1_resume_1020; P7 p7_stream_artifacts_v1_1020. P1/P2 have an agreed exclusive boundary for managed reducer versus HostKernel and are coordinating P2's observation_digest receipt schema. P2's durable recovery UNKNOWN fix is source-only. P7's targeted per-path checkpoint recovery preview is source-only; reset refusal and effectful restore remain disabled. P8 is queued after prior agent exit; P3/P4/P5/P6/P9 remain queued or partial.

Implementation-first hold remains; no validation commands. Git state remains mixed, one worktree, and preserved. C: via /mnt/c has 60 GB free. V1 is PARTIAL / NOT RELEASED; implementation, then final-revision verification/acceptance/release remain.



P1 and P7 aligned on checkpoint filesystem facts: P1 owns a typed descriptor-relative no-follow HostKernel per-path observation (path, kind, link count, digest, size, executable) with race checks; P7 consumes it through the existing workspace boundary, never a parallel reader. Restore remains unavailable until the host facts and Guarded dispatch exist. Selected-path recovery accepts only conflict-free captured regular files with one link; full reset after later commits stays refused. Normative preview contract and CP-001/CP-002 were updated in §§14.19, 16.18 and 32.


### 2026-10-19 20:44 UTC — source-only managed and checkpoint deltas

20:44 UTC source delta: P2 has added reducer source for atomic PlanRun, new RunPhase::Planned, and StartPlannedRun (RUNNING plus dependency roots READY); its Core plan path and authenticated HTTP goalRunStart handler are being wired. P1 owns the HostKernel plan_run/start_planned_run routes and must reject Planned from all dispatch/admission/control paths. P2 also changed direct receipt persistence to use observation_digest and persist recovery UNKNOWN. P1's typed descriptor-relative no-follow HostKernel workspace observation now carries path, kind, link count, digest, size and executable, with single-link rejection and race checks. P7's checkpoint manifest/preview now requires those trusted file facts; selected-path preview remains blocked until authenticated dirty/untracked status is complete and restore stays disabled.


Checkpoint preview provenance correction: the current trusted source compares workspace revision digests, not Git commit ancestry. The preview field is therefore workspaceRevisionChanged, not laterCommit. Full restore is refused on any revision change; no Git commit provenance is claimed. P7 renamed the source field and uses the same name in the projection. P1 received the private no-follow preview/recompute route contract from P7; VCS dirty/untracked status remains required before selected-path preview can expose actions.


### 2026-10-19 20:45 UTC — planned-run authority pins

P2 confirmed the planned-run reducer recomputes the canonical Task-set digest at goal.start and persists it in the start event; the operation body has no task/profile input. PLANNED rejects scheduler/admission/pause/resume and can be safely cancelled without creating effects. The user-facing API/TUI/SDK journey remains in progress; P1 owns HostKernel routing.


Additional P7 capture gap: current capture_guarded can accept snapshot bytes unrelated to the observed file manifest. P1 now owns a bounded opaque snapshot bundle minted by the same descriptor-relative no-follow traversal/race check, binding exact file bytes and manifest to the observed revision. P7 may persist only that bundle; capture/preview/apply remain unavailable until it exists. This is now normative in §14.19.


Cross-phase parent review found legacy HostKernel managed start_run/add_task ingress remains beside the new planned-run path. P1/P2 are coordinating fail-closed disablement/replay-only compatibility so no legacy call can create a dispatchable Run outside exact PLANNED + authenticated goal.start. VEO-023 now covers both ingress paths.


Attempt-bound ToolBatch design is now explicit in §14.3: approve and bind the full exact set before first dispatch, then issue/consume one lease at a time. A successful settled receipt and correlated refreshed scope are required before leasing the next member; failure/UNKNOWN/missing/mismatch fences the remainder. P1 is implementing the HostKernel/Core API expansion under the already authorized P1 scope; VEO-019 now covers this sequence.


### 2026-10-19 20:52 UTC — trusted checkpoint capture bundle consumed

P1 has added the bounded `TrustedWorkspaceSnapshotBundleV1`, minted from the same descriptor-relative no-follow traversal that derives the workspace revision and file manifest. P7 now makes checkpoint capture consume only that opaque bundle, derives file records and manifest digest from it, and persists its serialized bytes instead of request-supplied bytes. `CHECKPOINT_CAPTURE_ENABLED` remains false until P1 completes and the parent reviews authenticated Guarded HostKernel wiring; preview actions still require authenticated VCS dirty/untracked facts, and restore apply remains unavailable. This is source progress, not acceptance evidence. No tests/builds/typechecks/audits/probes/benchmarks ran. P1, P2 and P7 remain active whole-phase owners; V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:53 UTC — runtime route gaps and serial lease implementation

P7's source review found the remaining runtime boundaries explicitly: HostKernel still lacks AutomationServiceV2 and checkpoint snapshot-preview routes; Core/TUI lacks automation list/edit/history; guarded checkpoint restore and artifact eviction adapters plus receipt recovery are absent. P1 now owns the HostKernel/Guard routes and is implementing `effects.v2/lease_next_batch_effect`: HostKernel chooses the next exact Attempt-bound intent from durable ordered state, requiring a successful prior receipt and current observed workspace head before issuing one lease. Approval binds the full set before the first dispatch; Core must execute sequentially and request each later lease only after the prior receipt settles. P2 owns canonical managed Core/API/TUI control; P7 continues replay/render/artifact source work. These dependent effects remain unavailable until their authority, receipts and recovery are wired. No checks have run.


### 2026-10-19 20:56 UTC — explicit managed start reaches the TUI

P2 reports the TUI now obtains a trusted Goal snapshot, derives current Goal revision and accepted SpecVersion ID/digest, requires a `PLAN_ONLY` Run, then calls `goalRunStart` with only Goal/Run/idempotency and surfaces returned phase/revision or conflict. Core's legacy `startRun`, `addTask` and `markTaskReady` exports/service methods have been removed. SDK snapshot fields and fixtures remain in progress. No checks have run; this is source status only.


### 2026-10-19 20:57 UTC — Goal snapshot pins and automation control source

P2 has added accepted SpecVersion and per-Run `specID` fields to the Goal review snapshot projection and updated generated SDK response shapes, completing the source data needed by `goal.start`. A TUI regression fixture now covers deriving the accepted SpecVersion/revision from the trusted snapshot and sending the start request; it has not been run. P2 is moving to Core/API/TUI automation list/edit/history while P1 defines the HostKernel route and response bounds. C: last checked at 59 GB free (88%); Git remains mixed (150 staged, 235 unstaged, 173 untracked; no conflicts) and untouched.


### 2026-10-19 20:58 UTC — incomplete direct receipt cancellation fence

P2's source audit found direct `Cancel` can currently mark an Attempt CANCELLED while bound effects have no terminal receipts, and P1's HostKernel path can release its terminal slot. A batch cancelled after a successful prefix also needs a typed durable proof that all remaining intents were unleased/revoked. Cancellation without that proof must become UNKNOWN and retain/fence the slot until reconciliation; cancellation proven before dispatch can be terminal. P2 is tightening reducer receipt-chain semantics and P1 owns HostKernel cancellation/slot handling. This is source-only; no tests or validation run.


### 2026-10-19 21:00 UTC — renderer bounds and lease replay gap

P7 has source changes to clip raw renderer input before sanitization, cap aggregate rendered output with inert-source fallback and truthful FAILED fidelity, validate stream envelope seed advances correctly, and bound artifact-reference metadata before text encoding. No tests/builds/typechecks ran. Parent source review of P1's new `lease_next_batch_effect` found a lost response could strand an issued next lease because retry rejects an existing lease digest; P1 has been asked to return the same authority safely or reconcile an unconsumed lease after restart, and to define exhaustion behavior. P7 confirms checkpoint preview/VCS facts, guarded restore/eviction and HostKernel automation routes remain open source work. C: last checked at 59 GB free.


### 2026-10-19 21:02 UTC — parser and replay bounds tightened

P7 now caps completed artifact source at 16,384 lines before split/parser allocation and returns inert source with FAILED fidelity above 512 KiB rendered output. Oversized replay deltas request a canonical resnapshot rather than direct delivery; invalid cursors are not forwarded as trusted resnapshot IDs. ArtifactRef metadata is checked against a 4 KiB limit before trimming/allocation. All are source edits only; no tests/builds/typechecks ran. P1 still owns authenticated checkpoint preview/capture, same-boundary VCS status, Guarded restore/receipt reconciliation and AutomationServiceV2; P2 owns automation control API/TUI. P7 keeps these effect paths closed pending those contracts.


### 2026-10-19 21:04 UTC — P8 resumes as whole-phase owner

P7 returned PARTIAL after completing its independent renderer/replay source work; its remaining runtime routes and evidence are blocked on P1/P2. The freed child slot is now assigned to `p8_resources_workers_full_resume_1019` for the entire P8 resources/workers/worktree/RC0 phase. P8 owns its durable worker, worktree, resource and RC0 modules; P1 owns HostKernel/Guard integration and P2 owns managed-control/Core integration. P8 must continue independent work, coordinate exact proof/lease boundaries, and keep fan-out unavailable pending verified P1/P2 prerequisites. Active child roster: P1, P2, P8. No validation commands have run.


### 2026-10-19 21:08 UTC — managed TaskTool caller dependency

P2 source review found no production caller for managed Task execution: `TaskTool` admits only DirectAttempt and calls `ops.prompt` with direct authority; `promptManaged`/`ManagedAttemptAuthority` are not yet wired. P2 cannot safely add the managed dispatch adapter until P8 supplies the authenticated scheduler-to-Core proof/handoff and P1 provides the HostKernel admission/Guard boundary. P8 has been asked for the exact proof, reservation, delegation binding, digest attachment, dispatch, cancellation and recovery sequence; P2 continues independent automation/reviewer/verifier/UI work. Managed effectful execution and worker fan-out remain disabled.


### 2026-10-19 21:12 UTC — managed admission ordering settled

The §12.18/§37.22 ordering is now explicit in §37.22 and §17.18: HostKernel mints opaque `TrustedPreAdmissionPinsV1` from authenticated current Ready Task/Spec/profile/context/Guard/workspace/budget/parent facts; P8 durably reserves and returns `ReservedWorkerLeaseProofV1`; P1 atomically appends Attempt + DelegationBinding + exact refs; P8 attaches the binding digest; then authenticated one-use `managed.claim_dispatch` returns `ManagedDispatchHandoffV1` to Core TaskTool. Crash/lost response remains RESERVED/UNKNOWN until OwnerLog reconciliation; no timeout release or automatic relaunch. P1/P8 are implementing this boundary; P2 consumes the opaque handoff when available and continues independent P2 source work. Managed dispatch stays unavailable until the full chain is present.


### 2026-10-19 21:15 UTC — automation owner and storage boundary

P1 has supplied the strict `automation.v1` operation set and P2 has added the Core RPC adapter plus typed HTTP handler using trusted principal and registered Location. Parent settled the HostKernel owner boundary in §37.10: Rust persists only under private `state_dir/automations/`, scoped by authenticated owner binding plus registered Location/workspace; no request path or Session-only persistence. List/create/update CAS require a bounded Rust-owned registry in addition to per-definition occurrence journals. `run_now` stays unavailable until Guarded invocation and receipt recovery exist. P1 owns the HostKernel route; P7 owns the Rust registry/journal; P2 owns the SDK/TUI path. No checks have run.


### Active source checkpoint — Goal start and automation

User-selected managed-start contract: accepted SpecVersion → persisted complete PLANNED Run →
explicit authenticated `goal.start`; start is idempotent/revision-fenced and grants no Attempt or
effect authority. P2 has source for the Core/API/SDK/TUI path; final Rust routing and acceptance
remain open. Parent source review found P2 automation response mismatches, which it corrected;
Core `runNow` now refuses locally with CAPABILITY_UNAVAILABLE before issuing an RPC. P1 must
keep Rust `run_now` unavailable before scheduling or Guard. The Rust bounded registry/index is P7
owned, while P1 progresses remaining P1 work and coordinates the typed interface. P1, P2 and P8
are active. Implementation-first hold remains: no verification commands have run.


### Active source checkpoint — managed dispatch fence and DAG planning

P8's source now exposes the durable `ClaimedWorkerDispatchProofV1` facts (Attempt/worker IDs,
binding and pins digests, OwnerLog ID/sequence/event digest, pool revision and stable claim
nonce); P8 confirms this is a separate log from managed control. Parent arbitration therefore
assigns the no-replay `ConsumeManagedDispatch` marker to the canonical managed-control OwnerLog:
P1 authenticates and invokes it, P2 owns the reducer event, and P8 owns the durable one-use claim
proof. No cross-log atomicity is assumed. Core persists the exact consume receipt and pending
prompt state before provider dispatch; ambiguous restart is UNKNOWN/no automatic retry. §§17.18
and 37.22 now record this contract.

P2 also removed the single-Task/one-criterion plan ceiling and now builds bounded 1–64 Task DAGs,
validates exact criterion coverage, dependency membership/cycles, and pins each AgentProfile
revision. This is source-only. P1/P2/P8 remain active; no tests/builds/typechecks/audits/probes/
benchmarks have run. V1 remains PARTIAL / NOT RELEASED.


### Active source checkpoint — durable handoff/restart work

P1 has changed post-dispatch missing or malformed write/patch response and receipt handling to
best-effort persist UNKNOWN and return uncertainty, rather than surfacing a validation error that
could invite retry. P1 is reviewing cancellation/reconciliation branches and wiring the managed
consume route. P2 owns the typed `ConsumeManagedDispatch` reducer event in ManagedControl; P1
validates the live P8 claim and calls it. P8 now records exact pre-admission RESERVED worker IDs
in restart/owner-epoch recovery events so they do not timeout-expire across the P1 admission
window; CLAIMED/RELEASE_PENDING remains quarantined. These are source changes only. P2's bounded
1–64 Task DAG plan source is present and profile-pinned. P1/P2/P8 remain active, with all
validation still deferred.


### Active source checkpoint — authenticated Core peer identity

P1 source review found HostKernel request context currently retains owner epoch and negotiated
process-incarnation string but not the OS-authenticated Core PID/start identity. `unix_peer.rs`
validates SO_PEERCRED and executable identity, but the identity is dropped before request
routing. Parent assigned P1 to propagate a private typed listener-to-HostKernel context carrying
PID/UID/GID, executable identity and process-start identity, bound to the negotiated incarnation;
these facts must never come from RPC bodies. Missing identity keeps managed root admission
unavailable. §§17.18/37.22 now record the rule. This is source work only; no tests/builds/
typechecks/audits/probes/benchmarks have run.


### Active source checkpoint — durable candidate renewal (2026-10-19)

P8 is adding an opaque `PreAdmissionReconciliationReceiptV1` reconstructed from its exact
durable EXPIRED tombstone event. It binds NotAdmittedNoDispatch, exact candidate worker/ticket/
Attempt and pins, P8 OwnerLog cursor, pool revision, and reconciliation/receipt digests. P2 owns
the private idempotent `AbandonPreAdmissionCandidate` reducer transition and persisted Task
generation; P1 validates P8's opaque receipt and derives a fresh deterministic candidate from
Task ID + persisted generation. P8 enforces candidate Attempt uniqueness; tombstoned IDs cannot
be reused and generation advance grants no dispatch authority. P1 reports private listener-only
Unix peer identity fields plus live PID/start/executable validation; its hello/fence relation
still needs an explicit source comment. P1 source-repaired the partial-prefix cancellation
predicate, with phase completion ongoing. No validation commands have run.
Candidate identity binds Task ID plus durable `attempt_count` and `candidate_generation`:
admission increments the first counter, while only a verified pre-admission tombstone increments
the second. P2 CASes both in the abandonment proof/event/receipt; P1 includes both in immutable
reservation pins and derives the candidate from this tuple, preventing collisions after admitted
retries.
Candidate tombstone proof and receipt use typed P8 disposition/reservation enums with strict
persisted-event decoding. P8 removed an invalid comparison of worktree base-revision locator to
measured workspace content revision; both remain distinct immutable pin values (§§21.11/37.22).
No validation ran.
Candidate identity was refined to include both `Task.attempt_count` and
`Task.candidate_generation`: successful admission advances attempt count; only a verified
pre-admission tombstone advances candidate generation. P2 CASes both in the abandonment
proof/event/receipt, and P1 pins both before deriving IDs. This makes admitted retries unique.


### 2026-10-19 — candidate renewal integration checkpoint (source only)

P8 now exposes durable reconciliation-receipt lookup by candidate Attempt ID for exact `NotAdmittedNoDispatch` + `EXPIRED` tombstones. P1's authenticated `managed.reconcile_pre_admission_candidate` accepts only Goal/Run/Task selectors, derives identity from persisted Task `attempt_count` and `candidate_generation`, validates current accepted SpecVersion/profile/SessionLink/Location/workspace plus authenticated Core peer and ServerAuth/no-process state, and supplies P2 the opaque P8 receipt. P2 recomputes the candidate and CASes both counters on the exact READY Task under managed revision and delivery idempotency. P8 validates uniqueness and distinct workspace-content/worktree-base revision pins. This source path creates no Attempt or dispatch authority.

Implementation remains in progress for whole phases P1/P2/P8; P1 managed admission/claim/consume and P2 production managed TaskTool dispatch still depend on P8 durable proofs and canonical P2 consume integration. P3/P4/P5/P6/P7/P9, final integration and release remain open. No tests/builds/typechecks/audits/probes/benchmarks were run.


### Active source delta — candidate replay and dispatch fence

P1 now consults P2's exact `candidate_abandonment_receipt(delivery_id)` before deriving the current candidate generation. Replay still revalidates authenticated ServerAuth, Goal/registered Location/workspace, then matches P8's opaque `NotAdmittedNoDispatch` + `EXPIRED` receipt and the exact Task counters, pins, worker/ticket, and receipt digest before returning the durable result. P2 also added an exact `managed_dispatch_consumed_receipt(attempt_id, delivery_id)` lookup; P1 has been asked to use it before any P8 lookup or candidate dispatch proof reconstruction. Source only; no tests/builds/typechecks/audits have run.

P2 confirms `TaskTool` remains fail-closed for managed attempts because HostKernel `managed.claim_dispatch` / `managed.consume_dispatch` are not yet wired. `goal.start` is mounted through the goal-review handler; SDK/TUI source includes automation controls, while `run_now` remains unavailable. P1/P2/P8 continue as whole-phase owners; the managed child dispatch dependency remains open.


### Source decision — managed lease inputs (2026-10-19)

Resolved P1's request for implicit admission defaults from the existing owners: trusted inputs come from the authenticated accepted SpecVersion, the Task-pinned AgentProfileV2, and P8's durable pools. Each Attempt reserves one `ActiveWorkers` unit bounded by both WorkerPool `max_live_workers` and Spec `max_workers`; this is admission accounting, not an OS quota. CPU/memory/disk/FD are measurement/backpressure only unless OS enforcement is proven; unsupported explicit memory/disk guarantees remain unavailable, and no synthetic quotas are created. P2 must persist trusted `goal.start` time so Attempt expiry can use remaining Spec `max_run_duration_ms`; profile `limits.wallTimeMs` further bounds it when present; the existing 24-hour lease ceiling applies, and expiry never releases a lease. P8 supplies worktree ID/base locator only from eligible clean durable registrations; HostKernel's content digest stays a separate pin. Missing eligible worktree or unknown required capacity keeps admission unavailable. Architecture decision recorded in §17.19 and implementation contracts in §§21.11 and 37.22. Source-only; no validation run.


### Source delta — persisted start time and lease resolver (2026-10-19)

P2 now derives `Run.started_at_ms` from the canonical OwnerLog envelope `time_ms` for `planned_run_started`; replay reconstructs the same value. HostKernel's `goal.start` response projects that trusted time, and the managed owner exposes remaining accepted Spec duration; this timestamp is not request supplied. P1 corrected its caller to keep `start_planned_run` timestamp-free and will require a positive trusted remaining duration when deriving child lease expiry. P8 is implementing `resolve_managed_worktree` from its durable registration owner and correcting the distinct Task revision / workspace content digest / worktree base-locator pins. P8 must also project trusted ActiveWorkers capacity from pool limits; CPU/memory/disk/FD stay monitoring unless OS enforced. Source only, no checks run. Managed admission/claim/consume remains absent; TaskTool stays fail-closed.


Architecture synchronization: §03.4 now describes lease limits and worktree source; §04.2/4.3 bind Run duration to the durable OwnerLog envelope timestamp; §12.1 exposes Run.startedAtMs as a derived projection. These reflect the current P2 source direction and settled §17.19 policy; still unverified.


### Managed child runtime boundary decision (2026-10-19)

Resolved P1's question from §17.18/§37.22 and the existing Core TaskTool seam: managed children run as logical Core Session/Task/Attempt inside the existing Core process; V1 does not launch a second model-host executable. The immutable Core Config AgentProfileV2 selects model/harness and child policy. P8 WorkerExecution is lineage + resource/worktree lease identity, not spawn authority. Shell/process effects still pass through the single P1 Guard/ExecutionHost. LSP/DAP executable-profile projection is a separate P4 contract. This is recorded in §17.20, §03.4/§03.5 and §37.22. No checks run.


### Active managed-admission source delta (2026-10-19)

P8 now exposes an admission-only `DurableManagedLeaseProofV1` purpose tagged `PreAdmissionReserved`, built from exact immutable pins and current RESERVED OwnerLog proof with no attached binding/process authority. The separate post-append resolver requires purpose `AttachedAttempt`. P8 also added the durable registered-clean-worktree resolver and one-ActiveWorkers capacity projection bounded by pool `max_live_workers` and Spec `max_workers`; base locator remains distinct from measured workspace digest.

P1's HostKernel `managed_admit` source now follows authenticated profile/context/current Task checks → root peer proof → P8 worktree/reserve → P2 atomic Attempt+DelegationBinding → P8 binding attachment → post-append attached proof. This is CODE_PRESENT only. Parent identified a required exact admission-response replay before P1's current revision/READY checks; P2 is adding a delivery-keyed receipt lookup and P1 must revalidate current auth/workspace/P8 attachment before returning it. Managed `claim_dispatch` / `consume_dispatch` and Core TaskTool handoff remain open. No tests/builds/typechecks/audits/provider probes have run.


### 2026-10-19 — managed claim profile digest boundary (source only)

Core resolves the Task-pinned AgentProfileV2 definition from trusted Config and sends that exact
content with authenticated managed claim and consume requests. HostKernel recomputes the canonical
Rust definition and permission-ceiling BLAKE3 digests and compares them to the durable Task,
DelegationBinding and P8 pins before prompt dispatch; Core does not duplicate Rust's MessagePack
digest implementation. The contract is recorded in arch_V1 §§17.21 and 37.22. P1 owns HostKernel
validation and sampling route; P2 owns Core request parsing/calls and the reachable TaskTool prompt
path; P8 owns durable resource/worktree/worker state and authenticated Core resource measurement.
P1 has source for admission-receipt replay before stale revision checks and revalidates current
root/process/workspace/P8 attachment. Parent review asked P1 to compare permission-ceiling digest
to the durable P8 pin and remove a duplicate workspace-binding predicate. P1/P2/P8 remain active;
P3/P4/P5/P6/P7/P9 plus integrated acceptance/release remain open. No tests/builds/typechecks/
audits/probes/benchmarks have run by user direction. Preserve mixed Git state; no stage/commit/push.
C: last checked using /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 — managed dispatch adapter and recovery boundary (source only)

P1 now has HostKernel source for authenticated `managed.claim_dispatch` / `managed.consume_dispatch`, exact
admission-receipt replay before stale revision checks, profile definition/permission digest
revalidation against durable Task/DelegationBinding/P8 pins, and consume-receipt replay that
revalidates current authenticated owner, root/process identity, workspace and P8 binding. Handoff
numeric fields use canonical decimal strings across Core IPC. Parent review confirms admission
replay checks exact profile permission-scope digest and a single workspace-binding predicate.
P8 added authenticated Core-process sampling separately from worker-tree measurements and is
implementing an exact replay resolver for a claimed P8 lease after a lost claim response; claimed
work remains fenced if proof/process/cancellation/epoch facts are ambiguous. P1 owns the HostKernel
sampling route only where an existing architecture owner supports it; no new public endpoint is
assumed.

P2 added typed Core claim/consume adapters that resolve the exact trusted AgentProfileV2 and send
its definition for Rust digest validation. P2 has resumed whole-phase work: the production
scheduler-to-TaskTool caller and durable prompt-pending/restart state remain absent. Rust
ManagedControl/OwnerLog remains the canonical scheduler; Core may only execute Rust-selected
bounded ready Tasks inside the existing root Session/TaskTool path. Task selectors cannot come
from model/tool arguments. Exact consume must be persisted before provider dispatch; crash after
possible provider invocation becomes UNKNOWN with no automatic repeat. P2 continues the complete
reviewer, effect intent, live workspace revision, verifier evidence and Goal/TUI/recovery work.

P1/P2/P8 are active whole-phase owners. P3/P4/P5/P6/P7/P9, cross-phase acceptance and release
remain open. The implementation-before-validation hold continues: no tests, builds, typechecks,
audits, provider probes or benchmarks have run. Git remains mixed and untouched; no stage/commit/
push. C: last checked through /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.



### 2026-10-19 — Rust-selected managed Task and child Session boundary (source only)

P1 added a bounded authenticated `managed.next_schedulable_task` projection using canonical Rust
ManagedControl selection. It returns the exact candidate Attempt counters/profile pin and bounded Goal/
Spec/criterion context; Core does not select Task authority. P1 is separating `parentSessionID`
(Run SessionLink/root coordinator) from `sessionID` (durable Task child Session) through admission,
P8 pins and handoff. P2 has typed claim/consume Core adapters and resumed whole-phase work to
connect the Rust-selected candidate to existing TaskTool/promptManaged with a durable child Session
and prompt-pending record. Each Task gets a distinct child Session parented to the Run root; model
or tool arguments cannot choose Task/Attempt/session IDs. P8 is adding an exact durable WorkerClaim
receipt/resolver for lost claim responses; no process dispatch follows merely from replaying it.
These decisions are recorded in arch_V1 §§17.20–17.21 and 37.22. P1/P2/P8 remain active; P3/P4/P5/
P6/P7/P9, cross-phase acceptance and release remain open. User-directed implementation-only hold
continues: no tests/builds/typechecks/audits/provider probes/benchmarks. Git mixed and untouched; no
stage/commit/push. C: last checked via /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.


### Active dependency decision — Run root Session binding

`goal.start` now has an approved interface extension: it carries the active top-level Core Session
ID. Core verifies the persisted Session's authenticated principal, project, workspace and Goal
relationship before forwarding. Rust pins that SessionLink in the same explicit start transition
and includes it in exact retry fencing. HostKernel performs authenticated P8 root-coordinator
registration before any scheduler/admission can proceed; failure leaves execution unavailable.
The start transition still grants no Attempt or effect lease. P1 owns ingress/HostKernel, P2 owns
reducer/API/Core/TUI, and P8 owns root registration/recovery. Source integration remains active.
Implementation-only hold remains; V1 is PARTIAL / NOT RELEASED.

Resource-sampling boundary (corrected): P8's sampler is Attempt-scoped telemetry/backpressure,
not admission authority. ActiveWorkers capacity is durably accounted in Rust against pool/Spec
limits. Do not sample before admission or turn unknown optional telemetry into denial. No public
resource wire operation before §12.16 ResourceSnapshot schema; diagnostics remains unavailable.

P8 source checkpoint: worktree journal recovery now permits an intent-only operation to resume,
but a durable `worktree_dispatch_started` marker recovers as UNKNOWN and cannot redispatch. Safe
release requires same-root clean pre-delete evidence, post-delete MISSING, and no dirty or
user-owned changes; legacy receipts without pre-release evidence are history only. P8 remains
active for whole-phase work; no checks run.

P8 found raw public WorktreeRegistration facts could feed admission without guarded creation
provenance. P8 is replacing them with an opaque durable registration from the exact settled
Guarded Create intent/receipt and HostKernel-resolved canonical path/base locator; P1 wires the
Guarded route. Fresh no-follow clean/owned/current evidence is mandatory for new admission;
legacy registrations remain historical only. Source work continues without validation.

P8 implemented `VerifiedWorktreeRegistrationV1`: exact durable completed Create + fresh Inspect
receipts are rebound to the owner, root generation, worktree ID, base-revision locator, measured
workspace revision and canonical path. P8 rechecks the receipts and requires owned no-follow
CLEAN state with zero dirty entries and no user changes. Legacy registration events cannot
qualify. P1 must wire the HostKernel worktree lifecycle route. Source only; no checks.

P1 confirmed the sampler cannot see sibling Run workers before an Attempt exists. Metrics remain
monitoring/backpressure only; unsupported required OS-enforced profile limits stay unavailable.

P1 source review confirmed no HostKernel Guarded worktree Create/Inspect/Release route, journal
or driver exists yet. Core direct create/remove stays disabled. P1 owns the guarded no-follow
operation/receipt path; P8 owns durable registration provenance and tombstones. Managed
worktree admission remains unavailable until both are wired.

P2 now persists protected authenticated ServerAuth ownership metadata on Session creation, rejects
goal.start for a Session owned by another principal, prevents HTTP mutation of owner/root markers,
and adds `sessionID` to the start response/SDK. Provisional Core store/instance/epoch guesses are
not SessionLink authority; the exact Rust SessionSupervisor BLAKE3 cursor/source projection
remains a blocker. Source only; no checks.

P8 found that a safely deleted worktree could remain marked Free and be selected again. It is
adding a durable registration tombstone gated by clean pre-delete and MISSING post-delete proof;
the ID remains historical/non-reusable. P1 admission must resolve only verified live
registrations and fail closed on ambiguous removal/replay.

Start SessionLink dependency: HostKernel has no Core SessionStore/projector and cannot derive
durable cursor/source metadata from `sessionID`. P2 supplies a private projection from trusted
Core Session owner state including authenticated principal and Goal/project/workspace binding;
HostKernel stamps its live owner epoch. Start remains unavailable until that exact projection is
wired; post-start SessionLink attachment cannot substitute.

Cursor digest constraint: Core `EventV2.latestCursor` returns SHA-256 over canonical JSON;
Rust SessionLink requires the actual BLAKE3 cursor from `hc_session_receipts`. P2 must use the
existing Rust SessionSupervisor projection. No digest rehash/wrapping is valid; unresolved cursor
keeps explicit start unavailable.


### Source correction — SessionLink and managed start (2026-10-19)

`SessionSupervisor.sessionProjectionCursor(sessionID)` returns the durable Rust projection ACK
checkpoint and exact BLAKE3 cursor; cursor acquisition is implemented. Remaining identity fields
are resolved from durable Core owners: immutable database sourceStoreID, immutable
project-directory sourceInstanceID, and per-Session sourceEpoch initialized to 1 and incremented
only for explicit source-lineage reset/replacement. Never synthesize from path/time/process epoch.
User confirmed explicit authenticated `goal.start` after accepted SpecVersion; it atomically pins
SessionLink and grants no Attempt/effect authority. P2 owns Core identity persistence/projection;
P1 validates and pins. Managed worktree operations use a private authenticated control request
routed through Guard/EffectIntent/lease/receipt/ExecutionHost, with selectors from trusted P8 state,
not model ToolBatch or caller paths/argv. Source only; no checks run.

P8/P1 worktree boundary detail: P8 issues opaque `WorktreeLifecycleOperationPinV1` with stable
idempotent operation identity, root owner/ref, fixed selected worktree identity/path, current
revision and durable intent cursor/epoch. The pin has no execution authority. P1 validates root
proof and routes through Guard + EffectIntent/one-use lease/receipt + confined ExecutionHost; P8
persists the possible-dispatch marker before invocation. Release needs clean pre-delete, MISSING
post-delete and no active lease, followed by permanent tombstone. After dispatch-start, restart is
UNKNOWN and cannot redispatch. No validation run.

Core SessionLink sourceDigest uses SHA-256 domain `horizoncode.session-link.source.v1\0` over the
exact ordered bounded projection fields in §12.3, with u64 big-endian UTF-8 byte-length prefixes;
null latest message/part refs encode empty, and transcript content is excluded. No checks run.

### 2026-10-19 22:06 UTC — user decision and live owner checkpoint

The user confirmed explicit authenticated `goal.start` after accepted SpecVersion and a complete persisted PLANNED Run. It atomically pins the authenticated root SessionLink, readies only dependency roots, and grants no Attempt/effect authority. P1 has source for typed HostKernel SessionLink decode, fixed-order SHA-256 validation, authenticated Core-peer checks, epoch stamping and atomic start. P2 is adding authenticated P8 root registration after that transition; no admission or scheduling may proceed until registration succeeds.

Actual active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical and P8 resources/workers/worktrees/RC0. P1 is implementing one global user-owned Core Config `git_executable` absolute path and private authenticated Core→HostKernel projection. HostKernel canonicalizes/hashes it, pins profile revision/digest, and rechecks before launch in the existing supervisor. Project/plugin config, ambient PATH and request-supplied executable/argv/path are forbidden. P8 has source for read-only pending intent, post-Guard/approval/lease possible-dispatch fencing, and removal receipt reconstruction/replay; focused regression source is present but unrun. P2's production Rust-selected scheduler→TaskTool managed prompt path remains absent.

P3/P4/P5/P6/P7/P9 plus cross-phase acceptance/release remain open. No validation commands were run; user-directed implementation-first hold remains active. Git is mixed and untouched; one primary worktree; C: has 59 GB via `/mnt/c`. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 22:09 UTC — start/profile ordering and worktree sandbox boundary

Parent source review corrected the ordering: explicit authenticated `goal.start` and P8 root-coordinator registration do not depend on optional Git configuration. P2 moves trusted Git-profile registration to the worktree acquire path before any Git dispatch. Missing profile denies worktree-backed admission while leaving the effect-free Run start valid.

P1 must keep all of `.git` protected and add only a typed broker-operation `.git/worktrees` write exception if the selected OS backend enforces it with no-follow/canonical roots. Git argv stays fixed and uses `--no-checkout`; if the backend cannot prove nested write isolation, lifecycle effects remain unavailable. P8 is adding a current-root/epoch-bound Inspect target derived only from the exact settled Create intent/receipt to complete first-use Create→Inspect→Register. Source only; no checks run.

### 2026-10-19 22:10 UTC — root registration and first-use worktree source updates

P2 moved trusted Git profile registration out of `goal.start`: start now remains SessionLink-pinned and registers the P8 root coordinator; the Git profile is registered through a separate adapter only before worktree acquire. P8 added an Inspect target resolver derived from the exact completed Create pin and settled receipt, with same current root/epoch, clean/owned/no-follow and no-prior-registration requirements. Release selection still requires a verified live registration. P1 must resolve `.git` gitfile common directories only through trusted no-follow HostKernel inspection and confine that separate metadata root; otherwise keep managed worktree actions unavailable for that Location. Source only; no validation.

### 2026-10-19 22:12 UTC — intent-only worktree restart recovery

P8 must not leave an intent-only Pending operation indefinitely ambiguous after the root epoch changes. Because P1 persists the dispatch-start marker before exposing a request to the supervisor, a Pending journal record with no marker/receipt proves NotAdmittedNoDispatch. P8 will append a durable retirement/tombstone receipt for the exact operation/key only with fresh authenticated proof of the same Goal/Run/root Session/Location/workspace lineage. The tombstone cannot change the tree or authorize dispatch; exact retry returns EXPIRED, and a new operation needs a new key plus fresh Guard/approval. Different lineage or ambiguous state stays denied. P8 owns the durable contract; P1 owns the pre-dispatch marker boundary.

P2 source update: root registration now validates the root execution ID, OwnerLog ID/sequence/event digest and WorkerPool revision as well as Goal/Run/Session/Location. Protected Core root binding pins schema version, accepted Spec ID/digest and SessionLink source digest; exact retries verify the same binding. No tests run.

P2 source review finding: Core's current `goal.start` handler recomputes SessionLink on retry, although Rust pins the initial value. The Rust Goal snapshot already contains `Run.sessionLink`, but the Core typed decoder omits it. P2 must carry the exact pinned link through the projection and use it for RUNNING/recovery; only a PLANNED Run may derive a fresh projection. Validate all owner/Goal/Spec/Session bindings before replaying root registration. This covers Rust-commit/Core-metadata crash recovery and moving-cursor idempotency.

P1's proposed first-create path is accepted conditionally: persist the exact P8 possible-dispatch marker after Guard/approval/one-use lease, then create only absent fixed metadata/destination directories by descriptor-relative no-follow operations beneath trusted canonical roots. Prepare confinement and launch fixed Git argv through the existing supervisor. No overwrite of existing/user-owned paths. A definite no-spawn result needs supervisor proof; any ambiguity is UNKNOWN/no retry. If OS backend cannot enforce the exact nested write roots, remain unavailable.

P8 source now appends `WorktreeOperationRetiredNoDispatch` for exact intent-only Pending operations only, under fresh same Goal/Run/principal/root-Session/Location/workspace/Spec proof. It yields a typed EXPIRED no-dispatch receipt, no worktree mutation or authority, supports exact same-key replay, forbids revival, and reconstructs the receipt on replay. An unrun source fixture and P8-owned §21.12 update are present. P8 continues remaining phase source review.

### 2026-10-19 22:15 UTC — current implementation-only checkpoint

P2 source now strictly decodes `Run.sessionLink` from Rust's Goal snapshot and reuses that immutable link for RUNNING `goal.start` replay; a fresh Core projection is computed only for PLANNED start. A parent source review caught and P2 corrected a snapshot-before-declaration dereference. P1 preserves the original owner epoch on exact HostKernel start replay; scheduling still requires fresh authenticated P8 root-coordinator registration.

P8 added a replay fence requiring the retired-no-dispatch event's current owner epoch to equal the replayed WorkerPool epoch. P8 source review still finds no production HostKernel guarded worktree route/sampling caller. P1 remains responsible for the authenticated worktree lifecycle route through Guard, approval, one-use lease, durable possible-dispatch marker, confined supervisor and receipt, with P8 owning durable registration/tombstone proofs. P2's scheduler-to-TaskTool child-session prompt path and full managed review/verifier/recovery remain open.

Implementation-first hold: no tests, builds, typechecks, audits, provider probes or benchmarks. Active whole-phase owners: P1/P2/P8; remaining P3/P4/P5/P6/P7/P9 await available slots (P4 has partial source only). V1 remains PARTIAL / NOT RELEASED. Git state remains mixed and untouched.

P8 source follow-up: resource samplers now derive Core PID/start/incarnation from fresh authenticated peer facts supplied at sampling time, closing stale same-epoch token reuse. The sample remains observational; no pre-admission dependency or unsupported OS quota claim is introduced. Production sample route remains unwired and requires P1's authenticated peer proof if needed.

### 2026-10-19 22:19 UTC — P8 durable settlement producer ruling

**Ruling:** `WorkerPoolControl` must not durably append SettleWorker/ReconcileRelease from caller-built `WorkerSettlement` / `ReconciliationProof` booleans. Use opaque crate-private P1 HostKernel-minted settlement/reconciliation proof values, bound to exact P8 cursor/revision/state, managed Attempt + DelegationBinding, claim nonce, P1 process generation/owner epoch and exact P2 terminal/effect evidence. P8 rechecks its own state and derives internal transition flags before append; exact receipt replay is stable, while stale or ambiguous evidence remains quarantined. No new public RPC. This is recorded normatively in arch_V1 §17.24. **Cost if wrong:** extra proof plumbing and implementation time; if instead loose booleans were accepted, caller assertions could release worker capacity without proving process exit and effect settlement.

### 2026-10-19 22:19 UTC — V1 logical-worker settlement clarification

**Ruling (supersedes the process-exit part of the 22:19 ruling):** §17.20 defines managed WorkerExecution as a logical child Core Session/Attempt in the shared Core process. V1 settlement must not assert or wait for a worker-specific PID exit, because no such child process is launched. Keep the opaque P1/P8 proof boundary, bind authenticated root/Core peer identity, exact P8 cursor/revision/claim/Attempt/DelegationBinding, P2 terminal Attempt and complete effect receipts, and P1 proof that the child prompt/callback scope, Attempt leases and owned command processes are quiescent. Guarded workspace facts determine worktree reuse; uncertain evidence retains/quarantines capacity. A future process-backed worker mode must prove its exact supervised process exit separately. **Cost if wrong:** requiring a nonexistent PID makes V1 settlement impossible; allowing logical completion without the durable effect/quiescence chain could release active capacity while effects remain in flight.

P1 source delta (22:19 UTC): exact SessionLink start replay preserves pinned owner epoch; admission deadlines use the minimum trusted profile/accepted Spec/persisted remaining Run/24-hour values; Git profile registration requires ServerAuth plus current authenticated Core peer; the trusted executable is re-canonicalized and rehashed immediately before spawn; EffectHost permits only exact Git worktree IDs for UserAction. No P1 lifecycle route/driver exists yet. P2 is producing a crate-private Rust terminal Attempt/effect-chain projection for P1 to combine with prompt/callback quiescence and current peer/process/workspace facts; P8 WorkerExecution is logical Core child with no child PID. Production P2 TaskTool caller and P1/P8 settlement route remain source gaps. No checks run.

2026-10-19 22:20 UTC — Cross-phase quiescence ruling: §17.24 adds `managed_dispatch_quiesced`, a one-use ManagedControl OwnerLog event appended from P1's opaque proof after Core's exact managed `promptManaged` call returns and outcome is durably recorded. HostKernel checks current Core peer, consumed handoff/child Session/Attempt and no Attempt callbacks/Guard leases/owned commands. Exact retry returns the marker without re-prompt; missing marker after possible dispatch means UNKNOWN and retains P8 capacity. P1 owns HostKernel proof validation; P2 owns Core caller and ManagedControl event/snapshot projection. No validation.


### 2026-10-19 22:24 UTC — implementation checkpoint

P1/P2/P8 continue whole-phase implementation. P2's canonical terminal snapshot now includes a durable quiescence marker cursor and separates workspace revision domains; P1's HostKernel quiescence digest consumes that typed snapshot and exact child effect IDs, current authenticated peer observations, and exited process receipts. P8's logical-child settlement consumer and replay receipt remain unfinished; the boolean/process-exit producer is being replaced. Parent review flagged the invalid Task revision/workspace digest comparison for repair.

P5 source correction: the ordered cascade now retries explicit transient 408/425 once after the first pass. Authentication 401/403/407 fall through only to other enabled/configured routes; 429 records cooldown and falls through without retry; other 4xx stop. Production route dispatch remains unavailable until P1 Guarded transport and P6 SecretBroker integration are complete. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 22:30 UTC — P5 no-key provider chain expansion and source correction

Parent continued independent P5 work while whole-phase P1/P2/P8 owners remain active. Research against current provider primary pages found anonymous/no-key search support for Exa MCP, You.com `profile=free` (100 queries/day), Tavily MCP's explicit keyless search mode, Firecrawl Keyless (per-IP daily cap), and Parallel Search MCP (anonymous lower-rate mode). TinyFish Search is free but its documented API path requires account/API-key or OAuth, so it is not classified as part of the anonymous no-key default. Updated §37.5 and §16.7 accordingly and added source links/recheck caveat to §42.

Source-only P5 changes: Core config now recognizes `tavily_keyless` and `parallel_keyless`; the cascade's enabled default/order and route cap now include the five anonymous no-key routes; adapters expose those fixed endpoints/tools (including Tavily's fixed keyless headers); the TUI settings list represents both routes and keeps network dispatch unavailable pending Guard. The route parser now accepts common provider snippet fields, and tool-display labels cover both additions. Parent also fixed transient 408/425 classification earlier. P5 remains partial: no production Guarded transport/SecretBroker composition, native grounded-model route, broader BYO adapters/credential controls, route-event/provenance integration, or acceptance evidence is complete. Search remains fail-closed. No tests/builds/typechecks/audits/provider probes/performance runs were executed; Crawl4AI's browser binary was unavailable and Context7 quota was exhausted, so official primary-page web search/open was used as a fallback.
