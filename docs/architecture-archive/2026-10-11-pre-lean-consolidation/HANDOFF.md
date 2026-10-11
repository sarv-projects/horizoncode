# HorizonCode — Implementation Handoff

**Updated:** 2026-10-10 · **Workspace:** `/home/sarvesh/business_Dev/agentx` · **Branch observed:** `main` · **Architecture authority:** `arch_V1/README.md` and adopted decisions in `arch_V1/17-GOVERNANCE-DECISIONS.md`.

**Purpose:** Be the concise, durable starting point for any new coding-agent session. The historical `CURRENT_RUN.md` is extensive and locally ignored; consult only when tracing old evidence. This file must be refreshed after each verified implementation slice.

## Mission

Finish implementation of the OpenCode-first universal software-building/coding agent for non-developers and developers. Continue autonomously from gate to gate while work is safe and authorized; don't stop after one small patch. Requirements include fast direct editing, trusted tools, natural-language + visual building, durable managed goals, security, transparent cheap/free/local model selection, bounded parallel subagents, self-healing, verification, operation and export.

## Source-of-truth reading map

**Start-up compulsory:** `AGENTS.md` → this file → `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → `arch_V1/27-IMPLEMENTATION-READINESS-AUDIT.md` → `arch_V1/10-DELIVERY.md` → `arch_V1/24-LOCAL-CODE-AUDIT-AND-MIGRATION.md` → `CURRENT_RUN.md` last two dated sections.

**Full architecture read once before broad changes:** `arch_V1/01-SYSTEM.md` through `arch_V1/26-UX-ACCEPTANCE-AND-RELEASE.md` plus `GLOSSARY.md`, `README.md`. For a slice, re-read its owning sections; do not replace those contracts with broad assumptions.

**Specific contractual clusters:**
- OpenCode reuse, provider/auth/session/model: 01, 06, 09, 19, 20, 24.
- Run, context, events, lifecycle, API/data, IPC: 02–04, 11–13, 15, 20, 25.
- Effects, permissions, environments, testing/recovery: 05, 14, 17, 18, 21, 23.
- UI for novice/developer, picker, commands, skills/MCP, preview: 07, 16, 22, 26.
- Implementation sequencing, source gaps and acceptance: 08, 10, 17, 23, 24, 27.

## Repository facts — verified vs not

| Subsystem | Observed implementation status | Evidence / next check |
|---|---|---|
| OpenCode provider/LLM/session/tool code | **Locally present** from pinned OpenCode; not rewritten | `packages/opencode/src`, `packages/core/src`, `packages/llm/src`; compare to `opencode/` pin before upstream edits |
| Rust kernel OwnerLog/protocol/cancel/transport | **Code and tests exist; Linux Session observer is authenticated and process-tested**, but this is not yet the managed `hz-kernel` runtime | `kernel/src`, `kernel/tests`; full current counts in latest verification ledger |
| Read-only Rust OpenCode Session projection | **Implemented and tested** | `kernel/src/session_projection.rs`, `kernel/src/bin/session_sync_probe.rs`, `kernel/tests/session_projection.rs` |
| Live WAL Session event following | **Implemented as diagnostic follower, not automatically supervised** | `packages/core/test/kernel-projection-live.test.ts`; last run 3 Bun tests / 26 assertions |
| OpenCode Session projection parity | **Actual `SessionV2.prompt` admission/promotion, one recorded complete provider turn, automatic compaction history and blocked-provider interruption history are verified through Rust projection/replay; restart recovery during an active turn remains open** | `packages/core/test/kernel-projection-live.test.ts`, `packages/core/test/session-runner-recorded.test.ts`, `packages/core/test/session-runner.test.ts`, `kernel/src/session_projection.rs` |
| Linux local peer authentication | **Rust authenticates the Bun host executable; Core checks private socket owner/mode and binds Hello to a fresh nonce/incarnation** | `kernel/src/unix_peer.rs`, `packages/core/src/session/supervisor.ts`, process tests; Windows remains gated |
| Linux startup-bound RPC connection | **Core Effect-scoped child launches the observer and waits for negotiated READY; Rust validates/replays source before READY** | `packages/core/src/session/supervisor.ts`, `packages/opencode/src/effect/app-runtime.ts`, Rust supervisor |
| Bounded Session event pages | **Typed negotiated page-end/resnapshot controls, exact ACK cursor and `hasMore`; Core enforces next-sequence and oldest-first ACK** | Rust protocol/subscription and Core client; cross-runtime tests |
| Kernel supervisor / authenticated IPC | **Linux Bun-to-Rust integration receives actual OpenCode prompt events, stops on Unsubscribe/scope interruption, checkpoints completed pages, and resumes after restart; service is registered in the HTTP root, while automatic Session lifecycle and native Windows remain open** | Core SessionSupervisor, Rust `session_supervisor`, server route composition and live projection tests |
| Mediated tool/effect authorization across all paths | **Not implemented as complete enforced end-to-end boundary** | `packages/opencode/src/tool`, `packages/core/src`, `arch_V1/14-EFFECTS-EXECUTION-SECURITY.md` |
| Goals/DAG/tasks/checkpoints/evidence/verification | **Architecture and prototype schema, not runtime acceptance** | `arch_V1/11–12`, 15, 20, 25, `contracts-v2/` |
| Worktree leasing, parallel scheduler and self-heal | **Design only / implementation unverified** | `arch_V1/21`, 15, 23, 26 |
| Unified Create/Develop/Delegate/Operate UI | **Design only for the new experience**, upstream app exists | `packages/app`, `packages/desktop`, `arch_V1/16`, 22, 26 |
| Agent/model picker, local model harness, permissions UI | **Planned; upstream partial capabilities must be measured** | `arch_V1/16`, 21, 22 |
| Skills/MCP ecosystem | **Upstream code exists; runtime configuration incomplete** | `.opencode/skills/effect/SKILL.md`, `.opencode/skills/rtl-aware-development/SKILL.md`; `.opencode/opencode.jsonc` has `"mcp": {}` at last inspection |

The project is NOT complete. Docs and test harnesses do not imply shipping functionality. No live paid model calls are required for next gate.

## Latest verified test evidence

Last observed (2026-10-10):
- `cargo fmt --manifest-path kernel/Cargo.toml --check`: passed. `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline`: **148 passed** (71 unit + 11 owner-log golden + 25 recovery + 9 projection + 2 projection-subscription + 2 RPC delivery + 8 supervisor-process + 2 startup-session + 4 subscription-window + 5 supervisor-lease + 4 hello + 5 peer-auth). `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings`: passed. `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bins`: passed.
- From `packages/core`: `bun test ./test/kernel-projection-live.test.ts`: **5 passed, 52 assertions**. Tests call actual `SessionV2.prompt({ resume: false })` and `SessionInput.promoteSteers`; the Bun Effect-scoped host launches the Rust supervisor, receives actual projected events, rejects a forged out-of-order ACK, resumes a completed-page cursor after child restart, replays an interrupted partial page, and rejects rollback, symlink and malformed checkpoints. `bun run typecheck`: passed.
- From `packages/opencode`: `bun run typecheck`: passed. `bun test --timeout 30000 ./test/server/httpapi-cors.test.ts`: **3 passed, 10 assertions**, with `SessionSupervisor.node` in the active HTTP API root. Both tests were run without competing processes.
- From `packages/core`: `bun test ./test/session-runner-recorded.test.ts`: **1 passed, 15 assertions**; an actual recorded Core provider turn was projected twice from exact EventV2 rows into Rust, retaining ordered event versions and message correlation while excluding prompt and answer text. `bun run typecheck`: passed after this test addition.
- From `packages/core`: `bun test --timeout 30000 ./test/session-runner.test.ts`: **91 passed, 296 assertions**. Core now buffers local calls through provider `finish` plus `step-finish`, validates every call against its request-pinned registry, dispatches zero calls on provider failure/incompletion or any invalid sibling, and retains concurrent execution for valid batches. Recorded provider fixture passed **1 test / 15 assertions**; Core typecheck passed. This remains Bun ToolRegistry execution, not Rust Guard or the universal broker.
- Full Core suite: **1146 passed, 1 timed out** across 148 files. `util.flock > refuses token mismatch release and recovers from stale` hit its 5-second limit during a parallel run following long process-contention tests; `bun test ./test/util/flock.test.ts` passed **10/10** when isolated. Keep the full-suite timeout visible.
- Rust: workspace tests **148 passed**, format check, strict Clippy and both binaries passed on the last full run. Fixtures make no provider calls. Automatic Session lifecycle, a managed-control-plane consumer, native Windows and restart recovery during an active turn remain open. Compaction and interruption projection parity are now covered for the observed persisted histories.
- Current working tree contains **uncommitted changes from prior architecture and bridge tasks**. Preserve all; inspect `git status` before editing or committing. No push was performed.

## Immediate implementation — P1.2-B

**Outcome:** A production-shaped, authenticated, typed, locally supervised *read-only Session observer* that starts and stops reliably, subscribes/replays with bounded backpressure and healthy failure reporting, and integrates into the application without creating a competing conversation owner. Do not conflate this with secure tool authorization.

1. **Session parity:** A disposable file-backed fixture calls public Core `SessionV2.prompt({ resume: false })`, promotes via `SessionInput.promoteSteers`, and checks Rust sees versioned `PromptAdmitted` → `Prompted` in order with stable IDs and no prompt text. Recorded Core runner tests also project one complete provider turn, automatic completed-summary compaction, and a blocked-provider interruption, checking event ordering, message correlation, redaction and replay idempotency. Move parity and restart recovery during an active turn remain open.
2. **Authenticated RPC startup:** Linux `unix_peer.rs`, `rpc_handshake.rs` and `supervisor_session.rs` authenticate the host, negotiate protocol/features/nonce/incarnation, bind startup status to `StartupGate`, and gate app frames on READY. The Core client starts the binary, sends Hello, validates binding/features and waits for READY. Keep Windows runtime acceptance pending until tested natively.
3. **Bounded event delivery:** `SessionProjection.subscription_cursor/page` and `AuthenticatedKernelSession.send_subscription_page` provide an exact-cursor bounded redacted page with ACK flow control. Negotiated `page_end` and `resnapshot_required` controls carry the acknowledged cursor/hasMore and requested/latest same-owner cursors; process tests prove the source refreshes between pages and no partial page escapes on retention loss.
4. **Runnable supervisor and host lifecycle:** The Linux observer owns the authenticated listener, lease and read-only source/projection, validates/replays one Session before READY, and serves repeated cursor pages. Core launches it through `AppProcess`, negotiates Hello/features/READY, receives redacted events, enforces ACK order, and closes it from an Effect scope. The host atomically checkpoints only completed `page_end` cursors; interrupted pages replay safely. The service is composed in both CLI and HTTP server roots. **Next gate:** resolve explicit binary/state configuration and the real SessionV2-to-managed-control-plane consumer seam, then wire per-Session startup/shutdown/recovery.
5. **Verification:** Rust covers source corruption/schema and alias failures before READY, unauthorized peers, incompatible hello, lease exclusion/restart/overflow, bounded flow control, cursor drift, cross-subscription ACK rejection, repeated delivery and typed retention gaps. Cross-runtime tests cover actual Bun child launch, Hello/READY, real EventV2 prompt events, redaction, ACK order, scope interruption and epoch restart. Core runner tests now cover recorded-turn, compaction and interrupted-event projection parity. P1.2-B remains open for automatic lifecycle/cursor ownership, move parity, crash recovery during an active provider turn and native platform acceptance.
6. **Documentation and continuity:** Updated this slice in `arch_V1/13`, `24` and `27`. Continue updating `CURRENT_RUN.md` and this handoff after each verified slice, then proceed to P1.3 effect mediation only after P1.2-B acceptance.

**Do not prematurely implement the entire execution broker inside a read-only event follower.** Finish P1.2-B with verified authentication and replay, then proceed to P1.3 effects mediation.

## Follow-on dependency order after P1.2-B

- **P1.3 — Universal ToolIntent/effect broker:** enumerate *every* legacy and V2 effectful path (OpenCode shell, edit, Git, MCP/plugins, hosted tools, browser); mediate or explicitly disable bypass paths; per-mode OS-enforced scopes, idempotency, optimistic revisions, receipts and deny tests. Then single-agent end-to-end run with a local/free model where available.
- **P2 — Durable Goal/Run kernel:** additive OwnerLog/domain control records for criteria, DAG, attempts, checkpoints, run/session correlation and final-revision evidence. **Do not create a Rust canonical conversation transcript**; OpenCode Session/message/provider continuation remains canonical.
- **P3 — Reliable direct and managed coding:** repo intelligence, bounded context and compaction preservation, real tests/verification, recovery and stopping rules; do not substitute model 'done' for proof.
- **P4 — Multi-agent scheduling:** only parallelize independent work when worthwhile. Bounded reusable worktree pool, lease fencing, service/ports/DB isolation, merging, integration tests and cleanup/quarantine.
- **P5 — Model/harness/agent UX + local/free parity:** explicit provider/model selection (no silent routing), model capability probes, low-cost/local harness strategies, user-accessible permissions and diagnostics.
- **P6 — Universal app-building UX:** adapt existing OpenCode app/desktop into three-pane Explorer/Work/Inspect plus Create/Develop/Delegate/Operate, visual source mapping, previews, novice explanations, editor/terminal review, accessibility.
- **P7 — Ecosystem/operations:** audited skills/MCP/plugins/ACP/A2A as supported; deployment, backup/migration, app export, signed releases, platform compatibility, independent user acceptance, security and performance.
- **V1 cross-cutting capability gates (mandatory, dependency-ordered):** implement §§29–33 when their prerequisites are stable: rich specialist/custom profiles + maintenance jobs; Horizon Docs skill; ContextLedger and trim/prune/compact/clear; persistent symbol index/RepoIntel; Ollama/LM Studio/LiteLLM/OpenAI-compatible tiny-context runtime; smooth streaming/virtualization/CodeMirror 6/artifacts/Mermaid/Mission Control; deep analytics; automations; §32 real-work evaluation. §10 defines the exact gate order. **Do not interrupt current P1.2/P1.3 safety/control work merely to build UI extras.**
- **Post-V1 experimental learning lane:** V1 records deep analytics and reviewed advisory repair knowledge. Automated profile/prompt/config candidate generation/canaries are experimental after V1 and never self-authorize policy/model/extension changes.
- **P10 — POST-V1, DEFERRED AND MANDATORY: complete HorizonCode identity migration.** **Do not start during active V1 development.** After all V1 functional/platform/security/recovery/acceptance gates pass, inventory and replace all **product-owned** OpenCode package scopes, executable names, CLI help, internal import identities, config/env/persistence namespaces (with migration plan), desktop/web/TUI branding, assets, app IDs, protocols, installers, updater/publishing, CI and documentation. Preserve legally required upstream licenses/attribution. Validate built artifacts, existing-user data migration or deliberate clean break, installers and coexistence. Required **before public HorizonCode-branded distribution**, not before V1 implementation is functionally complete. See `arch_V1/10-DELIVERY.md` post-V1 milestone.
- Real gate ordering follows `arch_V1/10-DELIVERY.md` and `23-ADOPTION-GATES-TESTS.md`; labels above describe implementation tracks, **not** a renumbering of the normative historical phase table.

## Latest verified increment — compaction/interruption parity and Core dispatch barrier

- `packages/core/test/session-runner.test.ts` now projects exact EventV2 rows from the real Core automatic compaction path and a real blocked-provider interruption. Rust preserves the compaction Started/Ended pairs and message IDs without summary/recent-turn content; interrupted projection exactly matches committed event order and does not invent `step.started` when cancellation precedes it.
- Verification on 2026-10-10: compaction focused test **1 pass / 22 assertions**; interruption focused test **1 pass / 8 assertions**; Core typecheck passed. Exact test command and limits are recorded in `CURRENT_RUN.md`.
- `packages/core/src/tool/tool.ts`, `tool/registry.ts`, and `session/runner/llm.ts` now schema-preflight complete local tool batches before execution. Provider failure, interruption, incomplete EOF/step, or one invalid call withholds all local siblings and settles their recorded calls as errors. The full Core runner file passed **91 tests / 296 assertions**, and the recorded HTTP fixture passed **1 / 15 assertions**.
- This does not yet implement Rust ToolBatch ownership, Guard/resource/budget admission, ordered result acknowledgements or Rust ExecutionHost. Existing legacy, MCP, plugin and hosted paths remain outside an enforced universal broker.
- Production source trace: the OpenCode HTTP root composes the V2 `/server` Session API (`packages/server/src/handlers/session.ts`) using `SessionV2`/`SessionExecutionLocal`, and the compatibility Instance Session API using `SessionPrompt`. `SessionSupervisor.node` is registered in the root graph, but no production Session/control-plane consumer owns its events; the service registration alone is not automatic lifecycle integration.
- P1.3 source audit: Core V2 stages non-hosted calls through complete-response/schema validation. The compatibility Instance route sends built-in, plugin, MCP and custom tool callbacks through the AI SDK during the provider turn; explicit compatibility shell commands spawn directly through `SessionPrompt.shellImpl`; provider-executed tools cannot be intercepted after return. Existing host permission checks are not Rust Guard/lease enforcement. The exact path map and status are in `arch_V1/24`.
- **Next task:** implement the Rust **ManagedControl/SessionLink + ToolBatchControl** adapter that consumes the redacted OpenCode Session projection and commits Horizon-owned admission/correlation facts **without copying the conversational transcript**. Derive actor/scope from authenticated host context. Then implement Guard → durable PREPARED EffectIntent → one-use lease → ExecutionHost → target reconciliation before connecting any effect path. Keep production route convergence and automatic observer startup gated until a real consumer exists and every effect bypass is mediated or unavailable. P1.2-B still needs automatic lifecycle/stop/recovery, move parity, active-turn restart recovery and native Windows acceptance.

## 2026-10-11 competitive second-pass additions — queued behind current safety/control work

The deeper Codex/OpenCode/Cline/Grok Build comparison and low-confidence Claude reconstruction
research added V1 contracts/tests without changing the immediate P1.2/P1.3 priority:

- `LanguageServiceBroker`: coexist with editor/project Pyright, rust-analyzer, tsserver, clangd,
  etc.; reuse compatible instances, never kill/reconfigure editor-owned processes, retain
  source/generation provenance.
- Plan/read-only is enforced at Guard/ExecutionHost for shell/script/LSP/MCP mutations, not only
  by hiding edit tools.
- weak/local model structured calls fail closed; truncated tool JSON never gets guessed arguments.
- local endpoint timing separates connect/health from model cold-load/response-start/TTFT.
- `PlanHandoffV1` carries structured DAG/scope/criteria between Plan and Build.
- built-in `system-operator` and `browser-qa` specialists are explicit convenience profiles; they gain no authority from their names and remain subject to parent/profile/Guard intersection.
- canonical `horizon-docs` product asset now lives at `packages/core/src/horizon/skills/horizon-docs/SKILL.md`; the current `.opencode/skills/horizon-docs/SKILL.md` is only a development compatibility shim. Embedded registration, sealed-ID anti-shadowing and UI/runtime acceptance remain open.
- `HarnessProfileV1` now separates prompt/tool/message/response shaping from provider/model selection. Target built-ins are native-rich, native-minimal, bash-only and explicit compatibility profiles; changing harness must never silently change endpoint/provider/model.
- §35 explicitly maps the user's requested features and the follow-up OpenHands/mini-SWE-agent/Open Interpreter findings to owners/gates.
- terminal/artifact logs gain bounded search/range retrieval.
- checkpoint restore protects later commits/branch/dirty/untracked user work.
- fatal/exhausted managed attempts block/fail rather than continue burning tokens.
- §31 now requires control-plane latency stage budgets, incremental/frozen-prefix streaming
  behavior and crash-isolated expensive renderers (Mermaid first).
- §32 includes second-pass LS/LM/CX/TM/PL/CP/AG/LH/PF/RO clean-room task fixtures.
- current `indexd` is **not** a persistent semantic index yet: its local README describes only a
  bounded in-memory lexical PARTIAL slice. Do not mark RepoIntel/symbol/LSP work complete.

Implementation order remains governed by §10. Do not divert the current ToolBatch/effect safety
work simply to implement these later dependencies early.

## Subagents, worktrees and cleanup

Use subagents only if actually available and beneficial: one source/architecture investigator (read-only), one independent implementer per disjoint file group, one testing/security reviewer. Give each clear file ownership and completion artifacts. Integrator is the sole authority for cross-package merges, final test and handoff. Use real configured skills and MCPs only after capability discovery; `.opencode/opencode.jsonc` currently has no registered MCP server. Prefer simple single-checkout work for P1.2-B until worktree-pool semantics are verified. Worktrees created during this run require inventory, lease/owner, clean/dirt check, process and test DB cleanup, and safe reuse/quarantine. **Never delete dirty user changes.**

## Working loop and checkpoint contract

At startup: read `AGENTS.md`, this file, architecture index, current Git diff and source/test coverage. Announce one concrete gate; implement it. Every green slice: use the next unblocked dependency without asking the user for "continue"; record exact paths and test output; update statuses; clean created resources. If a blocker affects only one capability, move to another safe unblocked task. If forced to stop, give the next agent concrete next command, error, file, and remaining tests.

**End-of-turn is not end-of-project.** Preserve resumption truth; do not promise a daemon or scheduled background work unless the coding agent actually controls an authorized persistent runner.

## Current known open risks

1. Old v1 `Rust ThreadService canonical transcript` language still exists in historical sections; v2 explicitly targets OpenCode canonical Session. A gated source/version parity transition is required.
2. Existing provider/runner/tool paths may bypass a future Rust Guard until explicitly audited. No YOLO sandbox or permission enforcement may be advertised before full coverage.
3. Some architecture contracts are broad but prototype-only: API skeletons lack production auth/request validation; 15-table SQL design was in-memory tested, not applied.
4. Platform-specific Windows peer auth and live supervisor have not been proven in the new integrated runtime.
5. Model billing/usage, self-healing and worktree pool are design hypotheses until measured against real failure modes.
6. A broad repository `.gitignore` excludes files by default. Add the **narrowest** allowlist entries for each new source/test/handoff file, verify with `git status --short`, and do not use broad blanket unignore.

## 2026-10-11 contract convergence documentation slice

Updated normative §01 system topology, §02 identity, §03 direct Session flow, §04 event owners, §13 host/kernel IPC, §20 actual source mapping. Archived displaced material under docs/architecture-input/2026-10-11-superseded-contract-excerpts.md. New §36 convergence plan and §37 runtime-service LLD specify browser, language service, delegation, automation, UI cursor replay, artifact rendering and cache observations. Generated contracts-v2 schemas and capability alias seed, plus scripts/architecture/validate_convergence.py to check schema/alias/links/owner split. This design work changes no provider/kernel/runtime behavior; P1.2-B and universal P1.3 remain open. Newly specified interfaces require real shared TypeScript/Rust fixtures and platform acceptance before being called WIRED/VERIFIED. Do not start P10 identity rename.

## Verified architecture-contract baseline — 2026-10-11

Run python3 scripts/architecture/run_contract_tests.py for design-schema validation followed by the **existing, real** Bun Session-to-Rust projection and Rust authenticated RPC tests. Last manual source-bound tests on 2026-10-11: 5 Bun tests, 52 assertions, pass; 2 Rust tests, pass. Those tests do not validate the newly proposed Browser/LSP/Delegation/Automation/Mermaid/Cache services. Add generated TS/Rust binding validation, shared malformed/cross-process fixtures, security/timeout/replay tests before any new service is WIRED/VERIFIED.

Current implementation gate remains P1.2-B followed by P1.3; do not treat the design update as a passing kernel broker.

## 2026-10-11 OMP source research (non-gating)

Completed source-grounded source/reference audit at arch_V1/38-OMP-SOURCE-COMPETITIVE-AUDIT.md with machine inventories for 134 upstream docs, 30 public/3 hidden built-in tool names, 47 Rust native-module families, and selected implementation files, pinned to eec114a9226da698ebc015fd8996a8ca3bc4625c. It is NOT an adopted product/runtime change. Preserve active P1.2-B -> P1.3 sequence; integration candidates remain proposed until user approves architecture and linked tests, plus license review. No competitor code copied or Horizon runtime modified.

## 2026-10-11 OMP UI follow-up (source audit, NON-GATING)

Additional reference docs: arch_V1/39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md (85 builtin slash specs, 409 UI setting rows, 15 roles, 10 tabs, screenshot anatomy, source provenance); arch_V1/40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md (typed UX candidates and test gates); JSON evidence inventories omp-tui-command-settings-inventory.json and omp-provider-source-roster.json. This work DOES NOT implement OMP tools/commands, change OpenCode runtime, or make a §17 governance adoption. Continue existing P1.2-B/P1.3 implementation priorities; read-only research is not a production acceptance claim.

## 2026-10-11 OMP streaming/visual artifact source follow-up

Read-only source audit: arch_V1/41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md identifies streaming SVG preview, local/smart charts, terminal Mermaid/Kitty/SIXEL/Tern, FULL vs sampled durable artifact storage, and distinct remote screen-stream capabilities. Candidate Horizon adaptations exist as NON-NORMATIVE research appendices to arch_V1/31,37,38,40 and coverage §35; no product runtime adopted or edited. Keep P1.2-B -> P1.3 priorities and retain Core Session/Rust effect authority.

## 2026-10-11 final audit, external-source pins and executable replacement plan

**Operative plan:** docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md; **source pin/license & extraction map:** arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md + arch_V1/external-source-register.json; **service/function/test blueprint:** arch_V1/43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md; **full repo mechanical scan and known unresolved semantics:** arch_V1/44-FINAL-REPO-AUDIT-LEDGER.md + arch_V1/repo-file-line-audit-manifest.json.

This turn audited Git-visible source files mechanically (1.5M+ lines of source/text; SHA/line manifest) and archived semantically identified ownership contradictions; it did not manually understand every line or rewrite product runtime. Updated implementation documentation across §§09,10,16,17,19,20,23–27,29,31,32,34–37 and exact source research §§38–41. The old docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md now explicitly links the successor and remains historical. A-V2-22/23 accept UI/visual output behavior targets; A-V2-24 requires source evidence/license/contract/tests. All OMP adoption is still documentation/design; no OMP code copied, no native addon shipped, no integration claim. Resume P1.2-B → P1.3; do not interrupt user build/session or revive a Rust canonical conversation.

**Offline source provenance test:** python3 scripts/architecture/validate_external_sources.py (also included in scripts/architecture/run_contract_tests.py). It verifies source pins/URLs/owner fields and handoff links; it does not fetch or compile competitor code.

## 2026-10-11 ignored local upstream source copies

The user also has repos/cline, repos/codex, repos/deepseek-harness as ignored, local source copies (not Horizon runtime and no Git SHA verified). Exact per-file SHA/line inventory of 27,271 reference files and 5,919,094 text lines is arch_V1/ignored-reference-source-manifest.json. Do not clean/reset them. Use arch_V1/42 immutable public pinned repo links for actual source attribution, comparing local copies first if needed.
