# HorizonCode — converged implementation and competitor extraction plan (2026-10-11)

> **CURRENT CODING PLAN, STARTING AT P1.2-B; NOT A RECORD OF COMPLETED WORK.**
> This is the successor to the **SUPERSEDED** docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md and uses adopted arch_V1/17 decision ownership. It does not overwrite that historical document.
> Normative source order: AGENTS.md → HANDOFF.md / CURRENT_RUN.md → arch_V1/17,01,02,03,04,05,12,13,14 → arch_V1/20,24,25,36,37 → arch_V1/42 exact upstream pins and arch_V1/43 executable playbook → arch_V1/10,23,32 and requested UX cases.
> External competitor evidence is source-pinned, not code. OpenCode conversation owner + Rust managed effect owner cannot be swapped. No unapproved commits, force pushes, checkout deletion, large worktree cleanup or billed API use.

## Implementation protocol for every checkbox

Before a change: confirm exact local file/line + modified state; find owner and callers; retrieve pinned external reference only as needed; write failing tests; code the **smallest integrated slice**; run test+malformed/security+restart where relevant; update design/code status with evidence. Continue to next unblocked checkbox, but never fabricate test results or silently weaken security to advance.

Every checked task needs an evidence entry: (1) local Git HEAD and dirty file list; (2) exact path/functions and source pin(s); (3) test commands/output; (4) owner aggregate/auth/fallback; (5) user-facing smoke test; (6) regressions/limitations; (7) status CODE_PRESENT/INTEGRATED/VERIFIED as actually justified.

## Gate 0 — Source/handoff integrity and preservation (non-destructive)

- [ ] Read AGENTS.md, HANDOFF.md, CURRENT_RUN.md, and §17; confirm P1.2-B live status without changing uncommitted user-owned work.
- [ ] Read repo-file-line-audit-manifest.json and 44 audit report; resolve ACTIONABLE relative links, leave archived history/upstream test fixture links as historical.
- [ ] Verify first-party Git origin and actual HEAD against §42. Confirm OpenCode upstream pin via local historical source map; DO NOT replace local code with remote snapshots.
- [ ] Confirm all §42 external file URLs exist at exact immutable pins before implementation. Recheck license exceptions and source dependencies for each selected source.
- [ ] Run python3 scripts/architecture/validate_convergence.py and python3 scripts/architecture/run_contract_tests.py; note that design schemas are not runtime type conformance.
- [ ] Confirm active compiler/build concurrency; do not start competing full workspace builds or kill user tasks.

**Gate 0 exit:** verified sources and no ownership conflict; code changes limited to authorized paths and explicit user request.

## Gate 1 — Finish P1.2-B Core Session observer + supervisor

- [ ] Read packages/core/src/horizon, packages/core/src/session, kernel/src/session_projection.rs, kernel/src/supervisor_session.rs, kernel/src/startup.rs, kernel/src/rpc_handshake.rs, existing integration tests.
- [ ] Build SessionLink identity/cursor/epoch/redaction protocol in actual Core host without a second session writer; reconcile duplicate ACK/snapshot and interrupted tool-final events.
- [ ] Require bounded/authenticated local IPC; deny stale process epoch, replay missing cursor, malformed source event; reconcile observed session in both active and resumed flow.
- [ ] Run existing Bun live Session projection tests, kernel Rust RPC tests and process crash/restart integration; record exact reality separately from mocked fixtures.

**Exit:** OpenCode canonical data observed correctly, no Rust transcript or model loop, private host/kernel lifecycle test passes.

## Gate 2 — P1.3 whole-ToolBatch effect broker + authorization

- [ ] Enumerate ALL effectful tool handlers across Core V2 and legacy OpenCode: filesystem edits, shell, Git, browser/desktop, hosted provider tools, LSP workspace edits, DAP, plugin, skills, hooks, MCP, subagent tools, credentials and model/provider settings.
- [ ] Trace batch initiation from provider-generated final toolcall end to actual existing runner. Ensure no batch member dispatches until full schema parse/preflight; malformed batch fails closed.
- [ ] Implement Guard with per-turn pinned capability/permission/agent/harness/model profile, workspace revision, expected side effect class, effect budget, authorization scope.
- [ ] PREPARE durable EffectIntent with one-use lease in Rust; all effects routed through ExecutionHost, never raw Bun side effect after preflight. Existing read-only tools remain fast but checked.
- [ ] Produce idempotent receipt, cancellation state, versioned outcome: SUCCEEDED, FAILED, UNKNOWN/NEEDS_RECONCILIATION. Non-idempotent UNKNOWN must not be automatically re-executed.
- [ ] Explicitly disable any externally executed hosted tool that cannot be pre-authorized. No consent inferred from model text or plugin metadata.
- [ ] Test every effect class in ask/safe-auto/yolo-in-sandbox; deny host access outside scope in all modes; test direct Session without any Goal aggregate.
- [ ] Measure real tool dispatch latency and budget against §31; preserve low latency without weakening Guard.

**Exit:** one broker path for every included tool and documented disabled unsupported effects, negative bypass tests pass.

## Gate 3 — Cross-language schemas and owner log

- [ ] For each adopted service contract (§37), produce single versioned schema and generated TS/Rust types; reject field mismatches with shared fixtures.
- [ ] Test malformed/unknown enum/size/time/ID, schema alias collision, version negotiation, checksum and replay in actual Core and kernel processes.
- [ ] Implement additive managed control state: GoalDraft, SpecVersion, Run, Task, Attempt, EffectReceipt, Evidence, Verifier; do NOT follow old Rust Thread transcript cutover tasks.
- [ ] Ensure Run pause/cancel fences work and reconciles in-flight UNKNOWN, guards optimistic revision, verifies exact resulting repository revision and acceptance criteria.
- [ ] No automatic background continuation if authorized executor not actually running. Persist state and accurately show paused/NeedsYou.

**Exit:** Rust managed control/Effect data and Core Session data each canonical only for own aggregate; restarting/resuming verified.

## Gate 4 — Safe native editor/indexer/LSP/DAP

- [ ] Pinned OMP sources SRC-003/004/008 in §42. Inspect and test existing OpenCode edit, grep, glob and indexd before choosing adaptations.
- [ ] Hashline-style edits with observed-line anchors, full SHA256 and file revision fencing; safe relocation only with unambiguous content match; no-op detection and stale no-write.
- [ ] Bench Rust walker/AST/diff vs existing indexd on cold/warm large repos, symlink traversal, gitignore and cache revision invalidation; adopt only measured wins.
- [ ] LSP mux workspace/language lease, diagnostics data scope, crash/restart and guarded code actions/rename.
- [ ] DAP debugging adapter sessions, breakpoints, inspected variables and guarded process attach/evaluate. Disable unsupported OS debugger features.

**Exit:** source-mapped, tested and measured; no duplicate daemon or unguarded mutation.

## Gate 5 — Browser/desktop and inbuilt web search

- [ ] Source SRC-005/006/007 and §37. Tab/window owner and session type managed vs attached, observation/screenshot generation and active user approval.
- [ ] Browser: split read-only observations (DOM/ARIA/screenshot) from guarded navigation/click/upload/typing and network effects. Worker crash/invalidation and stale action denial tested.
- [ ] Desktop: OS capability matrix (Linux/Windows/macOS), window focus/AX screenshot freshness, coordinate transform, clipboard privacy, emergency cancellation, monitor DPI scaling and error receipt.
- [ ] Web Search: 20 direct and 6 model-grounded adapters are OMP research, not mandatory Horizon provider count. Create normalized provider adapters with auth/cost/time/result citation provenance, opt-in metered fallback, no copied free-scraper reliability guarantees.
- [ ] End-to-end three practical tasks per backend + adversarial network/host permission tests; no bypass if a third-party extension is installed.

**Exit:** authorized effects and verified platform-specific support; incomplete OS capability UI shows unavailable reason.

## Gate 6 — Models/providers/roles/settings/slash command UX

- [ ] Source SRC-009; model hub quick/session model picker vs all-model/provider/role hub. Agent/Harness choice remains separate and constrains eligible model list.
- [ ] Central ActionDescriptor + semantic icon/theme fallback, alias uniqueness, typed args, dynamic disabled/status reasons; all slash/button/keybindings/SDK/API share dispatch.
- [ ] Core provider catalog read-only projection first, with kind filters (chat/tiny/image/tts/stt/search/judge/embedding/rerank/video) and role slots; speed/price/context provenance declared/observed/unknown.
- [ ] OAuth where provider-supported, API key SecretBroker reference, env/keyless local models, custom base URL TLS/auth guard; model discovery refresh/cancel and honest authenticated vs cached vs unreachable status.
- [ ] Role presets and explicit scoped fallback global/project/Session, no unapproved model/harness reroute, no surprise payment. Optional advisor/judge costs explicit.
- [ ] Typed settings UI: ten OMP-inspired categories (but preserve all Horizon-owned fields), special plugins page, searchable sections, source/default/current/locked, validation, revertible preview, keyboards and accessibility.
- [ ] Goal objective dialog: draft+criteria+budget+external editor, review/approve before Rust StartRun; correct Stop/Pause/NeedsYou outcomes.
- [ ] Tests: OMP reference catalog 85 commands and 409 static setting declarations can guide coverage, but do NOT copy all of them or claim 1:1 implementation; capture Harmony action schema and actual UI smoke flows.

**Exit:** real TUI & desktop parity with no credential/permission leaks or input focus loss.

## Gate 7 — Streaming Markdown, SVG, Mermaid, charts and durable artifacts

- [ ] Source SRC-010 to SRC-016 in §42. Inspect OpenCode actual stream, TUI components, core provider tool delta and kernel artifact store before integration; do not add competing transcript.
- [ ] Incremental render: stable Markdown prefix + mutable tail; TUI source fence detector with streaming SVG partial repair, bounded isolated offthread native Rust raster, last good frame, generation fencing, source fallback and final prompt rendering.
- [ ] Mermaid after complete fence only; bounded pure Rust ASCII/Unicode render + width/theme/cache tests. Do not claim universal syntax.
- [ ] Numeric Markdown tables: wait until final row; deterministic local typed chart spec → theme SVG raster underneath original table, accessible text/table and correct units; paid Smart chart planning strictly opt-in.
- [ ] Terminal capability detection: Kitty/SIXEL optional Tern, per-surface graphic lease and budget, transmit once/place many, eviction/purge, 80/110/150 column widths, headless ASCII fallback and no scroll steal.
- [ ] Artifact canonical/full-vs-sampled persistence: SHA/size/MIME/owner/revision, atomic stage, read caps and export; graphical preview is ephemeral until durable receipt.
- [ ] UI stream: bounded coalesced repaint events, durable canonical events never lost or double-ACKed, crash/replay and source provenance.
- [ ] Optional redacted remote screen livestream explicitly deferred unless separate privacy/consent gate approved.

**Exit:** user can see streamed SVG/graphs/diagrams with source fallback on their actual terminal, and export saved original/derived outputs only when persistence verified.

## Gate 8 — Long-horizon, multiagent, automation and practical acceptance

- [ ] Schedule bounded independent work with reusable worktree/resource leases and cleanup/quarantine; no 100s untracked worktrees.
- [ ] ContextLedger, RepoIntel, trim/prune/compact/clear preserve OpenCode canonical history, use token telemetry measured/estimated/unknown, no secret context leak.
- [ ] Resume/recover after crash, provider error, file conflict, auth expiration, detached browser, LSP/DAP restart and effect UNKNOWN; explicit stop condition and no unnecessary model quota spend.
- [ ] Automation owner has deterministic missed/overlap/retry policy and live authorized executor; scheduler cannot act without Guard.
- [ ] Run §32 real work benchmark cases across local small/cheap/large provider capabilities, test model independence and accurate failure attribution.
- [ ] Produce security, performance, packaging, platform compatibility and UX report; only mark shipped after real integrated proof.

## Final gate — source and architecture reconciliation

- [ ] Every implemented module maps to §42 pinned source, §43 owner/algorithm, §37 typed contract and actual current repository file/function.
- [ ] Update §17 only for accepted decision changes. Keep HLD/LLD/process/schema/roadmap/test/UX/README/HANDOFF in sync and retire superseded instructions by header/link, not deleting historical evidence.
- [ ] Run python3 scripts/architecture/audit_repository.py --write and validator, then full language-level TS/Rust relevant tests and real UAT where needed. Surface verification gaps explicitly.
- [ ] No autonomous completion claim merely because 762+ static architecture checks or previous Bun/Rust projection tests pass.
- [ ] Identity rename P10 and self-improving policy changes remain post-V1 unless independently approved.

## Exact invocation for a coding agent

Read AGENTS.md, HANDOFF.md, CURRENT_RUN.md and this plan; start from the FIRST unchecked unblocked gate in dependency order, beginning with Gate 1 P1.2-B (or its current recorded failing test). Consult §42 and its JSON for immutable upstream source URLs and extraction instructions; consult §43 for owners and pseudo contracts. Reuse OpenCode code; add guarded OMP-inspired behavior only after security/adoption tests. Use subagents only on disjoint read/test work, integrate in main tree carefully, avoid worktree leaks, and update evidence before proceeding to next independently verifiable slice. Do not stop after a superficial test, do not weaken safety gates, do not spend money, and do not invent implementation status.
