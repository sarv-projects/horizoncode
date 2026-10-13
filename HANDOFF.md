# HorizonCode — implementation handoff

Updated: 2026-10-12
Workspace: /home/sarvesh/business_Dev/agentx
Branch: main
Observed HEAD before this uncommitted audit: 062a00d552340b672af607533ecd8d8e86856e3b

The working tree is intentionally dirty. Re-check git status, HEAD and active processes before editing. Do not reset, clean, stash, commit or push unless explicitly requested.

## Authority

Read in this order:

1. AGENTS.md
2. arch_V1/README.md
3. arch_V1/17-GOVERNANCE-DECISIONS.md
4. arch_V1/10-DELIVERY.md
5. arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md when external source reuse is involved
6. this file
7. docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md

Historical architecture/work logs are non-normative. The committed-base historical HANDOFF is preserved at docs/architecture-archive/2026-10-12-pre-repo-audit-HANDOFF.md; the local CURRENT_RUN.md retains additional work-log provenance.

## Current ownership

- Direct mode: HorizonCode Core, derived from the pinned OpenCode base, owns Session/Input/Message/Part and conversational continuation.
- Current direct provider transport: existing OpenCode-derived host/provider stack.
- Future direct provider migration (A-V2-27): selectively adopt OMP pi-ai/pi-catalog transport, auth, catalog and pricing beneath the same HorizonCode direct-session owner. Do not import OMP AgentSession/history/tool authority.
- Optional native OpenCode mode (A-V2-27): the official external OpenCode runtime owns its own native Session. HorizonCode holds a bounded session-link/event/verification projection. Never dual-own one conversation.
- Rust kernel: Guard/effects/leases/receipts plus future managed Goal/SpecVersion/Run/Task/Attempt/evidence/verification.
- UI/index/analytics are derived. Plugins/MCP/LSP/DAP/browser/desktop/REPL never gain independent mutation authority.

## Current verified evidence

### Repository and Git visibility

- Pinned OpenCode snapshot is tracked under opencode/.
- Root workspace is hydrated from that snapshot. Byte-identical upstream copies may remain ignored.
- Snapshot-to-root comparison: 6,627 pinned files compared; 62 root deltas; 0 changed deltas hidden and 0 hidden first-party source files after the .gitignore repair.
- scripts/architecture/audit_overlay_visibility.py now fails when a changed root overlay file is hidden by Git.
- Fresh local clone test: 5,762 missing hydrated files restored with bootstrap_source.py --apply; a second check found zero missing; tracked README hash/status stayed unchanged.
- git diff --check passes.

### Mechanical file and Markdown coverage

- Latest Git-visible mechanical audit: 6,847 files; 901 Markdown/MDX files; 1,727,398 readable text lines; zero read failures. Exact current file hashes and bytes are in arch_V1/repo-file-line-audit-manifest.json.
- Markdown/MDX content was mechanically read during the audit; no actionable current broken relative link was found. Link findings belong to archive/input/upstream fixtures.
- Ignored local reference copies were separately read/hashed: Cline 4,173 files / 1,148,507 text lines; Codex 8,979 / 2,338,229; DeepSeek Harness 14,119 / 2,432,358.
- Total local ignored references: 27,271 files / 5,919,094 text lines.
- This is complete mechanical coverage, not a claim that every source-code line received human semantic review.

### Typecheck and focused runtime

- packages/core targeted TypeScript check passed with zero diagnostics.
- packages/opencode isolated TypeScript check passed with zero diagnostics.
- Workspace manifest audit: 36 workspaces, 36 distinct package names, no undeclared packages, 30 typecheck scripts and 15 test scripts; zero manifest errors.
- Focused follow-up tests: 10 passed / 42 assertions across timing, session-owner and ToolBatch suites.
- Real V1 Rust Guard write-through passed: admission, approval, execution and receipt verified (1 test / 5 assertions).
- Prompt Guard denial passed: 2 tests / 4 assertions.
- ToolBatch gate passed: 8 tests / 28 assertions.
- Missing-challenge direct write denial passed: 1 test / 3 assertions.
- Core tool registry passed: 19 tests / 41 assertions.
- The expanded scripts/architecture/run_push_gate.sh PASSED end to end on 2026-10-12: uncapped run exit code 0 in 135.61 seconds. It validates source hydration/visibility, architecture/provenance contracts, Rust supervisor build, both modified TypeScript packages, Core registry and live Rust write, legacy owner/tool batch/denial and real V1 Rust receipt. A separate capped 260-second attempt had timed out under competing CPU/memory load; it did not reveal a test failure.

### Architecture contracts

- convergence validator: 1,071 checks / 0 failures.
- source/provenance validator: 413 checks / 0 failures.
- Active architecture stays lean: one topic owner per normative area; compatibility stubs remain non-normative.

## Validation result and remaining release gates

1. Full 36-package Turbo typecheck PASSED on 2026-10-12: 30 executable tasks succeeded, 0 failed, 0 cache hits, exit code 0 in 5m9s. This verifies TypeScript only; CI/release/end-to-end acceptance remains separate.
2. P1.3 is not complete. Rust Guard/ExecutionHost supports `files.write` and bounded multi-operation `files.patch`; V2 session revert uses `SessionSupervisor.runPatch`, and the V1 WebView/TUI revert callers use `/session/:id/revert` and `/unrevert`. The V1/Core persisted-state mismatch is fixed by validating legacy absolute paths, storing relative `restoreFiles`, and resolving them back on read. `Vcs.apply` and local Workspace `copyChanges` use guarded patch execution; remote/mixed Workspace copies remain fail-closed. New terminal finding: both V1 `/pty` and V2 `/api/pty` routes reach the Bun `Pty.Service`; `core/src/pty.ts` calls `#pty.spawn` and directly handles interactive input, resize, and process kill. The WebSocket path forwards client input to the process. These routes authenticate requests and scope connect tickets, but do not call Rust Guard/ExecutionHost. The focused PTY service suite passed 7/7, proving functionality only. Rust currently has no process execution or streaming PTY I/O RPC, so do not treat these routes as mediated or disable them without preserving the required terminal surfaces. Other P1.3 origins include DAP, browser, desktop, REPL, settings/auth/network, hosted/provider-executed tools, automation and external agents.
3. OMP provider integration is DESIGN only. Selected catalog/auth/transport/render source has been inspected and registered; no production OMP adapter is wired.
4. Native OpenCode adapter is DESIGN only. No production official-runtime lifecycle/session bridge is wired.
5. horizoncode npm/CLI identity is planned, not published. Internal @opencode-ai identifiers remain compatibility dependencies until a tested migration. hzcode is an optional future command alias.
6. Beginner visual-edit/deploy journey is designed but not implemented. Preview, source selection, deployment verification and rollback require real acceptance tests.
7. CI full-validation workflow exists locally but has not executed on GitHub; local Turbo typecheck success is not GitHub Actions CI success.
PTY security review found that start approval alone cannot authorize arbitrary later shell input, current `Pty.Service` inherits `process.env`, and WebSocket output buffering is unbounded. Contract selected (independent review pending): one Location-scoped instance of the existing kernel/supervisor implementation, no second process manager or new crate; explicit UI approval of a full-access terminal grant bound to local OS principal, owner, exact launch config and 60-minute maximum expiry; each input/resize is checked as a one-use effect under that grant; close revokes and fences input first. The PTY is not sandboxed. Rust derives principal from the OS; HTTP origin/auth and connect tickets remain separate access controls. Environment is clear-and-allowlist; supervisor output uses bounded framed events, Core byte-bounds retained output and WebSocket queues, and replay marks gaps. Windows ConPTY/named-pipe integration and native acceptance remain required; cross-compilation alone is not acceptance. OMP reference pin `eec114a9226da698ebc015fd8996a8ca3bc4625c` was inspected for UI-gated streaming PTY and filtered environment patterns; no code or dependency was copied.
   Historical OpenCode overlay verification on 2026-10-12: typecheck; targeted suite (614 passed, 1 skipped, 0 failed; 1,843 assertions across 58 files); changed-source Prettier checks; `git diff --check`; overlay visibility audit; pinned-source bootstrap. The MCP CLI test used a local loopback server and observed zero requests. This was an earlier source snapshot; the focused 2026-10-13 results below are the current evidence. No full-workspace or Windows acceptance was exercised.
Current runtime evidence (2026-10-13): `packages/core/test/session-projector.test.ts` passed 10 tests / 23 assertions. Core and OpenCode typechecks passed after the projection and route composition fixes. Local Linux acceptance used the existing `session_supervisor` binary, a test-only observer manifest, and a local mock provider: TUI Guarded write, `/undo`, and `/redo` changed the workspace file `before` -> `after` -> `before` -> `after`; WebView `Revert message` and `Restore message` invoked `POST /session/:id/revert` and `/unrevert`, both HTTP 200, and changed the file `after` -> `before` -> `after`. The TUI outside-worktree attempt was rejected as `path_outside_or_unsafe`; its sentinel stayed `before`. The V1/Core bridge persists validated relative `restoreFiles` and resolves them to legacy absolute paths for API reads. The in-memory OpenCode `revert-compact` test cannot exercise Rust observation because the sidecar cannot observe in-memory EventV2 DBs; file-backed runtime E2E covers restore. Fixed the V2 prompt-wake failure by passing `createRoutes` Layer replacements into `buildLocationServiceMap`; focused retry/promotion test passed 1 / 10 assertions, full `httpapi-session.test.ts` passed 27 / 148. PTY service suite `cd packages/core && bun test --timeout 30000 test/pty/pty-session.test.ts` passed 7/7 on Linux; it exercises current PTY behavior only, not Guard mediation. Existing evidence remains: kernel 160 tests / 15 suites; VCS 13 / 24 and Workspace 37 / 127 through local Rust supervisor; TUI workspace confirmation 1 / 1. Full 36-package Turbo typecheck and Windows acceptance were not run.

Question/clarification audit: `question`/`question.ask` code is present, wired in WebView and two TUI paths, and service/component/mock-tested, including multiple questions, MCQ/single-vs-multi choice, custom text, answer and dismissal. It is not specified as a canonical architecture/capability/acceptance item and has no live-runtime evidence. WebView uses V2 question routes; the new TUI lists through V2 but replies/rejects through V1. This is not Guard permission `ASK`. Record this as a V1 design/route-parity/runtime-verification gap; do not claim `question.ask` planned or verified.

## Git and source model

- Do not delete the root-workspace ignore strategy blindly: it prevents committing thousands of duplicate hydrated upstream files.
- Every file that differs from opencode/<same-path> must be Git-visible. The overlay visibility audit enforces this.
- First-party new files have explicit allowlist entries.
- Build outputs, node_modules, Rust target, caches, local reference repos, .env files, worktrees and local run logs stay ignored.
- Review exact staged files; never use git add . mechanically in this overlay model.

## Current implementation gate

P1.3 — universal ToolBatch Guard/ExecutionHost.

Continue by inventorying and migrating one remaining mutation origin at a time. Each slice needs:

- exact canonical capability ID;
- full-batch/schema validation;
- Guard/approval/lease;
- authorized executor;
- receipt/UNKNOWN reconciliation;
- positive test;
- denial/bypass test;
- cancellation/restart evidence where relevant.

Do not jump to browser/desktop/provider migration merely because the architecture exists.

## Provider and OMP direction

Use OMP selectively:

- pi-ai / protocol transports;
- auth selection/cascade where compatible;
- pi-catalog / Models.dev enrichment;
- provider compatibility rules;
- bounded rendering/model-hub ideas.

Do not duplicate OMP AgentSession/history owner, tool-policy authority, worktree/process authority, unrestricted plugin/computer execution, or unbounded UI queues.

OpenCode promotional Zen free models remain eligibility-restricted. Native OpenCode may be tested through documented official APIs, but HorizonCode must never spoof a client identity or promise free access.

## Next exact engineering work

1. User explicitly requires WebView and terminal/TUI parity. Existing V1 callers use `/session/:id/revert` and `/unrevert`; the Core projector now migrates validated absolute legacy file paths into relative `restoreFiles`, and OpenCode maps them back on read. Local Linux runtime proof: TUI Guarded write/undo/redo, WebView Revert/Restore with both POSTs returning HTTP 200, and an outside-worktree TUI attempt denied as `path_outside_or_unsafe` without changing its sentinel. No Windows acceptance.
2. VCS `apply` and local Workspace `copyChanges` no longer bypass `files.patch`: full suites pass against the local Rust supervisor (VCS 13 / 24, Workspace 37 / 127). The TUI workspace dialog accepts copy only on explicit `yes`; remote/mixed Workspace copies remain fail-closed. Do not repeat this slice; continue the remaining P1.3 origin inventory without bypassing Guard, exact target binding, receipts or UNKNOWN reconciliation.
3. Keep Gate 2 open; `terminal.run` still has no Rust implementation, and DAP, browser, desktop, REPL, settings/auth/network, hosted/provider-executed tools, automation and external-agent mutation paths remain to be resolved. Do not claim universal effect coverage or Windows acceptance.
4. Continue P1.3 with `terminal.run` under Rust Guard/ExecutionHost; V1 shell endpoints remain typed-unavailable. Interactive PTY contract is now frozen for independent review: one Location-scoped instance of the existing Rust kernel/supervisor, no second process manager or new crate; explicit UI approval of a 60-minute maximum full-access terminal grant, Rust-derived local OS principal, exact launch-config binding, guarded one-use input/resize effects, revocation-before-cancel, explicit environment allowlist, bounded framed output and byte-bounded replay with gap indication. Keep the terminal truthfully `full-access`, not sandboxed. Migrate both V1 `/pty` and V2 `/api/pty` plus WebSocket input through this owner; no direct Bun process effects remain. The current Horizon TUI has no `Pty.Service` callsite; preserve its existing shell/session behavior and the verified WebView/TUI revert flows, without inventing a second PTY UI. Windows ConPTY and named-pipe acceptance is still mandatory; cross-compilation is not runtime evidence. The V2 prompt-wake failure is resolved: `createRoutes` forwards dependency replacements to the location-scoped V2 services; focused retry/promotion and all 27 HTTP session tests pass. Run full-workspace typecheck/release gates at the integration boundary, not as a substitute for remaining effect-origin coverage.
5. Keep overlay-visibility and clean-clone gates green for every new source edit.
6. Only after the Guard boundary is broad enough, prototype selective OMP transport under the existing direct-session owner.
7. Prototype the independent official OpenCode native adapter with lifecycle/version/permission/restart tests.
8. Implement beginner preview/visual-edit/deploy verification only with rollback and observable-result tests.
