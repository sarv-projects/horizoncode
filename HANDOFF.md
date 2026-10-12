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
2. P1.3 is not complete. Verified file-write paths do not prove universal Guard coverage. Remaining effect origins include shell/process/Task/subagent, plugin/hooks, MCP, LSP mutations/install, DAP, browser, desktop, REPL, settings/auth/network, hosted/provider-executed tools, automation and external agents.
3. OMP provider integration is DESIGN only. Selected catalog/auth/transport/render source has been inspected and registered; no production OMP adapter is wired.
4. Native OpenCode adapter is DESIGN only. No production official-runtime lifecycle/session bridge is wired.
5. horizoncode npm/CLI identity is planned, not published. Internal @opencode-ai identifiers remain compatibility dependencies until a tested migration. hzcode is an optional future command alias.
6. Beginner visual-edit/deploy journey is designed but not implemented. Preview, source selection, deployment verification and rollback require real acceptance tests.
7. CI full-validation workflow exists locally but has not executed on GitHub; local Turbo typecheck success is not GitHub Actions CI success.
8. Moving-tree caveat: after the green Turbo run, additional kernel source/tests changed and four legacy memory/thread schema prototype files were moved into a newly Git-visible non-normative archive. A source-import scan found no remaining imports of those prototype identifiers in the active kernel/Core/OpenCode/schema/server/indexd roots. These later edits were not part of the completed Turbo/Guard test snapshot and require a fresh final validation when all writers have finished.

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

1. Complete the full-workspace typecheck/release-gate work separately from the fast push gate.
2. Continue P1.3 with direct shell/process/Task and other active mutation origins, fail-closing unsupported paths.
3. Keep overlay-visibility and clean-clone gates green for every new source edit.
4. Only after the Guard boundary is broad enough, prototype selective OMP transport under the existing direct-session owner.
5. Prototype the independent official OpenCode native adapter with lifecycle/version/permission/restart tests.
6. Implement beginner preview/visual-edit/deploy verification only with rollback and observable-result tests.
