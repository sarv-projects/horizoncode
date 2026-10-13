# HorizonCode — implementation handoff

Updated: 2026-10-13
Workspace: /home/sarvesh/business_Dev/agentx
Branch: main
Current HEAD and upstream status: re-check with Git MCP before resuming; this handoff does not pin a branch tip.

Working-tree state is task-specific. Re-check Git status, HEAD, active agents/processes and worktrees before editing. Preserve user-owned changes; never reset, clean or stash unknown state.

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
The guarded terminal contract is accepted/review READY in `.slim/deepwork/horizon-guarded-pty.md` `#4232`. One host-scoped `hz-kernel` in the existing kernel crate owns Guard/EffectHost/ExecutionHost and terminal processes across dynamically registered Locations; Core holds one host manager plus per-Session projection workers. No global workspace root or second process manager. User approval is explicit `allow_once`/`deny`, challenge-bound and one-use; terminal grants are full-access, never sandboxed. Details and wire bounds live in `arch_V1/14`, `30`, `32`, `33`, `37` and the operative plan.
   Historical OpenCode overlay verification on 2026-10-12: typecheck; targeted suite (614 passed, 1 skipped, 0 failed; 1,843 assertions across 58 files); changed-source Prettier checks; `git diff --check`; overlay visibility audit; pinned-source bootstrap. The MCP CLI test used a local loopback server and observed zero requests. This was an earlier source snapshot; the focused 2026-10-13 results below are the current evidence. No full-workspace or Windows acceptance was exercised.
Current runtime evidence (2026-10-13): `packages/core/test/session-projector.test.ts` passed 10 tests / 23 assertions. Core and OpenCode typechecks passed after the projection and route composition fixes. Local Linux acceptance used the existing `session_supervisor` binary, a test-only observer manifest, and a local mock provider: TUI Guarded write, `/undo`, and `/redo` changed the workspace file `before` -> `after` -> `before` -> `after`; WebView `Revert message` and `Restore message` invoked `POST /session/:id/revert` and `/unrevert`, both HTTP 200, and changed the file `after` -> `before` -> `after`. The TUI outside-worktree attempt was rejected as `path_outside_or_unsafe`; its sentinel stayed `before`. The V1/Core bridge persists validated relative `restoreFiles` and resolves them to legacy absolute paths for API reads. The in-memory OpenCode `revert-compact` test cannot exercise Rust observation because the sidecar cannot observe in-memory EventV2 DBs; file-backed runtime E2E covers restore. Fixed the V2 prompt-wake failure by passing `createRoutes` Layer replacements into `buildLocationServiceMap`; focused retry/promotion test passed 1 / 10 assertions, full `httpapi-session.test.ts` passed 27 / 148. PTY service suite `cd packages/core && bun test --timeout 30000 test/pty/pty-session.test.ts` passed 7/7 on Linux; it exercises current PTY behavior only, not Guard mediation. Existing evidence remains: kernel 160 tests / 15 suites; VCS 13 / 24 and Workspace 37 / 127 through local Rust supervisor; TUI workspace confirmation 1 / 1. Full 36-package Turbo typecheck and Windows acceptance were not run.

Question/clarification audit: `question`/`question.ask` code is present, wired in WebView and two TUI paths, and service/component/mock-tested, including multiple questions, MCQ/single-vs-multi choice, custom text, answer and dismissal. It is not specified as a canonical architecture/capability/acceptance item and has no live-runtime evidence. WebView uses V2 question routes; the new TUI lists through V2 but replies/rejects through V1. This is not Guard permission `ASK`. Record this as a V1 design/route-parity/runtime-verification gap; do not claim `question.ask` planned or verified.
## Current terminal implementation checkpoint — 2026-10-13

The source slice is **partial, unintegrated and unverified**. The existing V1 `/pty` and V2 `/api/pty` live route still reaches Bun `Pty.Service` until a full guarded cutover; no terminal-slice tests/builds/formatters were run.

- Rust additions include `kernel/src/terminal.rs` (validation, grant/replay/cursor primitives) and `kernel/src/terminal_process.rs` (reported Linux PTY and cfg(windows) ConPTY/Job Object backend). No test/build verified these modules. Process-tree kill-on-owner-close is not proven; the Windows peer/state-directory DACL/owner proof is explicitly unresolved.
- `session_supervisor` was changed to projection/ACK-only and `ownerEpoch` was added to HelloResult, but no integrated `hz-kernel` host binary/lease owner/multiplexed RPC/EffectHost dispatch/terminal service/artifact/recovery is proven. Removing the per-session effect owner before its host replacement works leaves a migration regression risk.
- Core `packages/core/src/session/supervisor.ts` has partial host launcher/client/Location APIs; `packages/core/src/trusted-principal.ts` defines the agreed context. Missing: positive epoch propagation/fencing, working Guard prepare/resolve and lease consumption, challenge reply lifecycle, PTY host calls/events and `SessionV2.shell`; direct Core file-effect migration remains incomplete.
- Root OpenCode, route and UI modules are not complete. The ShellAndTui handoff only claims a TUI error-visibility edit, app submission test update and session route description edit. Model `bash`, user `!`, GuardApproval UI, V1/V2 ingress/ticket/origin migration, WebView PTY adapter and every files.* caller have no verified end-to-end cutover.
- `TerminalDocs` updated `arch_V1/14`, `30`, `32`, `33`, `37`, `10-DELIVERY.md`, capability registry and plan; this handoff also records approvalID-only reply lookup and 404/409/400 mapping. There is no root `SPEC-CHANGELOG.md`; no such file was created.
- New source files `kernel/src/terminal.rs`, `kernel/src/terminal_process.rs`, and `packages/core/src/trusted-principal.ts` are ignored by `.gitignore:6 (*)`, so Git status omits them. Review the user's dirty `.gitignore` and overlay-visibility rule, then explicitly allowlist first-party changes before relying on Git diff/commit.
- Accidental edits under the nested reference-only `opencode/` checkout were restored using the inspected diff; recheck that subtree is clean. Do not use it as implementation target.
- All terminal agents were parked in the latest agent-list check. `RustTerminalKernel.HostLeaseWindows` reported bounded accept/retry work, but DACL/owner validation remains unfinished. Check `history://` before touching shared files; preserve their incomplete changes.
- Reference-gap rule (user re-emphasized): for unknown/missing features inspect pinned OpenCode and Oh My Pi implementation, especially Oh My Pi Settings behavior/source/state/tests, not screenshots alone. Root `AGENTS.md` carries the durable rule; no source was copied for this terminal contract.

V1 is **not release-ready**. P1.3 remains the active gate; later P2–P9 gates and Windows-native acceptance remain open. The user requires both WebView and terminal/TUI. Built-in `question`/`question.ask` supports multiple questions/MCQ in code and mock tests but remains absent from canonical plan/catalog/acceptance and lacks live runtime evidence; this is separate from Guard permission `ASK`.


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

1. Recheck Git status, ignored paths, active agents/processes and disk. Preserve the full dirty tree, keep nested `opencode/` read-only, and do not commit/push/reset/clean.
2. Finish and integrate the Rust host singleton, durable cross-platform epoch/lease and authenticated RPC; restore Guarded file effects through the host before removing any old path; implement dynamic Locations, terminal process/input/resize/cancel/status/events, bounded artifacts/search and UNKNOWN/recovery.
3. Finish Core host supervision, trusted principal context, epoch fencing, Guard challenge/one-use lease prepare/resolve/execute APIs, PTY/event adapter and V2 `Session.shell`; migrate all direct Core file-effect callers.
4. Finish OpenCode model ToolBatch `bash`/files.* migration; root V1/V2 PTY/ticket/origin/reply routes; WebView terminal panel adapter; TUI/app/CLI `!` shell and shared explicit GuardApproval UI. No `Permission` autoaccept/always, `ctx.ask`, direct Bun process, or fallback.
5. Review all diffs and Git visibility, then run targeted Rust/Core/OpenCode/TUI/app checks plus live Linux allow/deny/recovery smoke for both WebView and TUI. Native Windows ConPTY, Job Object, named-pipe SID/ACL/peer/fencing acceptance is mandatory; WSL/cross-compilation is not acceptance.
6. Only after P1.3 is complete, continue P2–P9 in the operative plan; the previous 36-package typecheck and local revert/VCS/Workspace tests do not verify this slice.
