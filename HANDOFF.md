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
7. As of the 2026-10-12 local evidence snapshot, GitHub Actions had not run. PR #1 subsequently obtained a successful full-validation workflow for commit `c325172492da5741ed416eb018bf724612a6ccf2` (run `38476485241`); see the dated PR completion audit below for current limitations. A green workflow is not proof of Experimental Settings runtime implementation.
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

## GitHub PR #1 implementation completion audit — 2026-10-14 (remote source only)

Reviewed the active architecture/implementation plan and the relevant source paths for optional Settings, experimental flags, TUI and GUI. This is a **targeted line/path review of the related implementation**, not a claim to have read and verified every file in the ~7,700-entry checkout tree. Review reference `c325172492da5741ed416eb018bf724612a6ccf2` plus subsequent audit edits on the draft PR branch. Current main remains at `dead4339cae87f9e48c25e4e9586096d600bb164` during this audit.

| Gate/feature | Observed source or evidence | Honest completion |
|---|---|---|
| P1.2-B observer | Previous source-and-test-bound handoff evidence (§ above) | Locally VERIFIED only for its stated test scope; not evidence for all platforms |
| P1.3 universal effects | Real V1/V2 Rust-mediated guarded write only; other effect origins still inventoried but not migrated | INCOMPLETE (current implementation gate) |
| Experimental feature **design** | §16.15, §17.9, §20.10.1, §32 FEAT-001..014, §33.28, `contracts-v2/feature-exposure-v1.schema.json` | DESIGNED |
| Experimental feature **static tests** | Positive/negative fixtures added to `scripts/architecture/validate_convergence.py` | CODE_PRESENT; record execution on this PR head before TESTED |
| Runtime feature-exposure descriptor / config precedence | Core V2 config, V1 config and migration, OpenCode instance config and env RuntimeFlags inspected | NOT IMPLEMENTED |
| Explicit per-feature experimental opt-in & blocked state | Broad inherited `OPENCODE_EXPERIMENTAL` controls exist; no new governed resolver | NOT IMPLEMENTED |
| TUI Features/Experimental Settings and readable tags | Existing app/command palette/status inspected; no matching metadata/view | NOT IMPLEMENTED |
| GUI/web Features/Experimental Settings | Existing desktop/web dialog only offers General, Shortcuts, Servers, Providers and Models | NOT IMPLEMENTED |
| Backend/API/TUI/GUI parity and migration | No FEAT-001..014 executable integration suite observed | NOT VERIFIED |
| Other planned V1 capability families | Current root architecture §10/§33 and status above describe target vs implementation | Not declared complete by documentation or this audit |

CI chronology: `HorizonCode full validation` GitHub Actions run [38476485241](https://github.com/sarv-projects/horizoncode/actions/runs/38476485241) passed for `c325172492da5741ed416eb018bf724612a6ccf2` after restoring the nested Bun `packages/opencode` workspace. That is real CI for that commit, **not runtime verification of Experimental Settings**. New audit-branch commits require fresh CI and schema checks. Do not carry old “zero workflow runs” claims forward as present-tense truth.

Next: first P1.3 effect-origin migration, then implement `FeatureExposureV1` through the existing config owner; UI surfaces read authoritative effective state. §20.10.1 lists concrete code locations, §32 FEAT-001..014 lists acceptance, and the operative plan records unchecked implementation steps. No source-runtime feature implementation has been completed by this audit.

## Feature Settings implementation checkpoint — 2026-10-14 (supersedes earlier design-only status)

Code now exists **on draft PR #1 only**, not on `main`:
- `packages/core/src/v1/config/feature-exposure.ts` — derived metadata for existing backend config; stable compaction auto/prune options and three unavailable Experimental candidates. This is not an independent settings registry or policy authority.
- `packages/core/test/config/feature-exposure.test.ts` — focused Bun tests for defaults, disabled experiments, unique IDs and safe minimal patches.
- `packages/tui/src/component/dialog-features.tsx` and `packages/tui/src/app.tsx` — working-code candidate for `/features` with explicit Experimental labels and existing SDK config read/update.
- `packages/app/src/components/settings-v2/features.tsx` and `dialog-settings-v2.tsx` — desktop/web Features and Experimental tabs using existing server-global config updates; GUI-local `settings.v3` is not used for backend authorization.
- `scripts/architecture/run_full_gate.sh` runs the focused Bun test **from the Core package directory**, respecting the pinned upstream `bunfig.toml` test-root restriction.

**Verified as of this checkpoint:** the GitHub full-validation workflow passed the pure feature resolver commit, TUI dialog/app wiring commit, and desktop/web feature view+tabs commit `50949e9f63bd740ad3deb8fe29b3a33a653763da`. The first attempt to run the *new* test command from monorepo root failed due to intentionally disabled root test discovery, not type errors; the package-local invocation is committed and must pass its own PR-head workflow. No interactive device smoke test was run.

**Still open:** feature-specific runtime server projection (UI currently derives from *server-returned config* using shared code), source-precedence / lock-source resolution, revision-aware concurrent writes, active-session pending-apply fidelity, arbitrary optional-feature inventory and FEAT-001..014 end-to-end tests. The three experimental engine backends remain unavailable even when listed, and P1.3 universal mutation mediation is a separate unfinished gate. This is a real initial product UI/config slice, not completed full Experimental infrastructure.

## V1 release-gap inventory and P1.3 bounded ToolBatch slice — 2026-10-14

Evidence boundary: targeted normative owners (§10, §14, §17, §18, §32), operative checklist and the current source/tests under `packages/opencode/src/session/tool-batch.ts` and `packages/opencode/test/session/tool-batch.test.ts`. This is **not** a claim that every tracked line or every future capability has been tested. PR commits are not on `main`; `HorizonCode full validation` last passed on prior PR head `eb57b447a239e5fc9acac33f3afe9f3153d5b2c4`. Await a **new passing run on the final slice commit** before marking this slice tested.

| V1 requirement | What is still needed to claim release completion |
|---|---|
| P0 pin/provenance | Preserve upstream snapshot and legal notices; full redistributable-license and packaging proof is still P9 |
| P1.2-B Session observer | Existing positive local evidence; platform/restart/support matrix must match shipped platforms |
| P1.3 universal Guard | Shell/process, Task/subagent, MCP/plugin/hook, hosted provider, network/settings/auth, LSP/DAP, browser, desktop, REPL, automation and external agent effect origins remain unverified or gated; active release blocker |
| P2 managed control | Accepted SpecVersion, durable Goal/Run/Task/Attempt, leases, pause/cancel, restart, unknown-effect reconciliation, evidence-bound final result |
| P3 coding/RepoIntel | Guarded normal read/search/patch/build/test/diff/retry; revision-safe edit; lexical/symbol index/update and measured latency |
| P4 language/debug/REPL | LSP edit safety, DAP lifecycle/evaluate isolation, bounded Python/JS worker and restart tests |
| P5 browser/desktop/web | Per-OS real interaction safety, stale-ref/permission tests; web search cost/auth/source provenance |
| P6 agents/settings | Typed bounded subagents, plugin/skill/hook/MCP trust; provider/model UX, one ActionDescriptor, server-authoritative optional Settings with source/lock/revision/pending and TUI/GUI/API parity; current `/features` slice is partial |
| P7 UI/artifacts/automation | Stable streaming/scroll, bounded UI mux/renderer, source-faithful artifacts/SVG/Mermaid/tables, measured costs and durable jobs |
| P8 long horizon | Real crash/recovery and stop-budget tests, bounded worktree parallelism, final outcome verification and cross-model evaluation |
| P9 ship | Legal/attribution, signing/update scope, native **Windows** sandbox/durability qualification, install/upgrade/migration, package name/CLI, clean-machine and security/UX/performance release gates |

**This implementation slice:** the pinned V1 streamed `tool-call` terminal gate now limits **32 tool calls**, **256 KiB per call JSON argument**, **512 KiB aggregate arguments**, and **256 UTF-8 bytes** each for the tool name/call ID, rejecting before accumulation, parsing, validation, Guard preparation, or local callback dispatch. Tests cover overflow count, single/aggregate bytes, overlong identities, valid 32-read boundary and mixed valid write plus oversized read. These numbers are safety ceilings for provider **terminal `tool-call` parts**, not coverage of stream lifetime, partial tool-input deltas, arbitrary stdout, overall tool results, memory across sessions, blocked provider-executed tools or external effect origins.

Remaining P1.3 work in priority order: (1) bounded partial tool-call delta/stream timeout and cancellation semantics; (2) source-by-source shell/process/Task admission or explicit unavailable; (3) stable permission/lease and durable effect/UNKNOWN recovery across the rest; (4) no-effect bypass tests for every enabled origin. Green tests for this limited bound do **not** close Gate 2.

No extra agent runtime, feature registry or duplicate effect policy is introduced by this slice.
