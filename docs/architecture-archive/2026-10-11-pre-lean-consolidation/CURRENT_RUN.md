# CURRENT_RUN — HorizonCode

## 2026-10-11 authoritative current handoff — supersedes old P2 Thread instructions

**READ THIS SECTION FIRST.** Earlier dated entries below are preserved historical work logs. In particular, the old 2026-10-10 text that tells an agent to implement a Rust canonical Thread transcript is SUPERSEDED and MUST NOT be executed. The adopted §17 A-V2-11 owner is OpenCode Core V2 canonical Session/Input/Message/Part/provider continuation; Rust kernel owns only Horizon managed Goal/Spec/Run/Task/Effect/leases/verification/evidence.

**Actual source at latest audit:** local branch main, Git HEAD bf0399469470c6ffdcbe5421dc5c506db2d61fae when inspected, significant user-owned modified/untracked work present. Recheck HEAD/status at run start; do not assume old a22f810da state, clean working tree, or remote branch parity. No commit/push/reset/prune/cleanup performed by this architecture audit.

**Operative implementation plan:** docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md.
**Exact external immutable source URLs/licensing/reuse decisions:** arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md and arch_V1/external-source-register.json, with OMP code analysis in §§38–41.
**Code-first owners/functions/LLD/negative tests:** arch_V1/43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md and existing §20/§24/§37.
**Mechanical repo audit and risk register:** arch_V1/44-FINAL-REPO-AUDIT-LEDGER.md and per-file SHA/line manifests.

**Next live gate:** verify actual P1.2-B read-only Core Session observer/supervisor against existing tests, then P1.3 universal ToolBatch preflight and Rust Guard/EffectService/ExecutionHost with no legacy bypass. Only after that: additive managed Goal/Run and bounded source-backed OMP UX/visual changes. Never revive Rust canonical conversation or second TUI/provider/credential system.

**Last focused verification (2026-10-11):** scripts/architecture/run_contract_tests.py passed 4 groups: 847 static architecture checks; 379 source-provenance checks; existing Bun Core→Rust projection 5 tests / 52 assertions; existing Rust authenticated RPC 2 tests. Git diff --check passed. These ARE NOT tests of newly proposed browser/LSP/DAP/UI/visual artifact implementation. Repository-wide Git-visible SHA/line scan and separate ignored reference tree scan exist as mechanical evidence, not human semantic proof. Re-run tests after code changes.

**Current user task:** exact pinned source reference inventory, full mechanical repository/source audit and reconciled implementer documents. New docs §§42–44 and the operative plan, plus appended cross-references, are uncommitted. Leave user source/code changes untouched.

---

## Active handoff — Local merge of `p2-foundation` (2026-10-10)

### Active Goal

The user explicitly requested merging `p2-foundation` into local `main`. The branch has
been fast-forwarded locally. Do not imply P2 or V1 release acceptance, and do not push
`main` while the P2/P0 acceptance gates remain open.

### Where We Stopped

- `main` and `p2-foundation` both point to `a22f810daa76f42e99a8e455af9e949bf9a4788e`
  (`docs(p2): record Thread cutover preflight`); `origin/p2-foundation` also points there.
  This was a fast-forward from `2627f7645`, and
  `git rev-list --left-right --count main...p2-foundation` returned `0 0`.
- Local `main` is 20 commits ahead of `origin/main`. No push was performed. The feature
  branch and its remote tracking ref were preserved.
- The merge includes the exact pinned OpenCode source snapshot under `opencode/`
  (`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`) and the P2 Kernel/documentation work. This
  is not an OpenCode-derived root Git base.
- Fresh checks on the merged tree passed:
  `HORIZON_OWNER_LOG_TEST_TMPDIR=/tmp/opencode cargo test --offline --manifest-path kernel/Cargo.toml`
  (70 unit + 11 golden + 25 recovery tests; 0 doctests),
  `cargo fmt --manifest-path kernel/Cargo.toml -- --check`, and
  `cargo clippy --offline --manifest-path kernel/Cargo.toml --all-targets -- -D warnings`.
- Tracked working tree is clean. The earlier pre-merge test accidentally ran on the old
  `main`; the checks listed above were rerun after merging and are the authoritative evidence.
- P2 remains incomplete: canonical Thread transitions, supervisor/owner epoch, Core V2
  `ThreadStoreService` adapter, one-to-one Session import/rollback snapshot, projection
  replay/rebuild/snapshot/resnapshot, and supervised crash/restart acceptance are not
  implemented. P0 provenance/base/inventory/baseline/generated-output/license gates and
  native Windows ACL/durability acceptance also remain open.

### Next Exact Steps

1. Resume the proposed Thread cutover plan at
   `docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md`; keep the unresolved P2
   prerequisite-scope decision explicit and do not fabricate Project/Profile/ContextEpoch/
   Artifact/Guard ownership or authorization.
2. Implement and verify the remaining P2 scope with targeted tests and a whole-branch review;
   do not claim P2 acceptance until the gate in `arch_V1/10-DELIVERY.md` passes.
3. Only after the required gates pass, push local `main`; until then, keep `origin/main`
   untouched.

## Prior handoff — Finish P2 and integrate pinned OpenCode base (2026-10-10)

### Active Goal

Finish P2 against `arch_V1/10-DELIVERY.md`. The user approved adding the pinned OpenCode
source and requested merge-back, staging, commit, and push after verification. Do not claim
P2 or V1 release acceptance before the architecture gates pass.

The globally installed `codebase-intelligence` skill is available to all repositories; it
is not a Horizon/P4 component. Use it for unfamiliar or repository-wide work, not trivial
single-file changes. Run it against the active project root (not the skill directory), after
checking that Python dependencies are available. Its SQLite index under `.code-intelligence/`
is disposable and should be gitignored. Prefer bounded `changes`, `locate`, `query`, and
`path` views; treat ambiguous/regex results as candidates, not semantic facts. It excludes
common generated/vendor/cache and secret-like paths, does not execute repository-provided
commands, and may report unsupported or parse-error files without semantic edges. Tree-sitter
is the preferred parser; NetworkX is optional.

### Where We Stopped

- Branch `p2-foundation`, current `HEAD=a22f810daa76f42e99a8e455af9e949bf9a4788e`.
  Documentation checkpoint `a22f810da` (`docs(p2): record Thread cutover preflight`) is
  pushed to `origin/p2-foundation`. Task 5
  implementation/docs are committed in `1c98f49d8`; Task 4 implementation is `1aa8207d0`,
  with verified review fixes in `b5f520f26`. The user chose
  to continue in this existing feature branch rather than create another worktree. Local
  `main` was `2627f76` and `origin/main` was `96cabbf25d3bd2f7500aef8f9a669046ce832545` at
  the last branch check.
- The `opencode/` source snapshot and provenance inventory are committed in
  `0b83e5f89`; the source is exactly pinned commit `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`
  (6,629 blobs, zero missing/extra/changed). Full dependency/asset/legal review, root-base,
  archive provenance, baseline/generated-output, and full path disposition gates remain open.
- OwnerLog review fixes are committed in `b5f520f26`: orphan segment gaps, missing first
  index rows, head/committed-byte changes while open, and derived-index transaction failure
  after canonical head commit.
- Fresh verification: 48 unit + 11 golden + 25 recovery tests passed (84 total; 0 doctests);
  `cargo fmt --manifest-path kernel/Cargo.toml -- --check`, strict host Clippy, and
  `git diff --check` passed. The append mutation check is O(retained history) I/O. Owner lock
  coordinates cooperating opens only; same-OS-identity writers that bypass it remain inside
  the current trust boundary and concurrent races are not claimed protected.
- `cargo check` for Windows MSVC remains blocked because bundled `libsqlite3-sys` cannot find
  `lib.exe` on this Linux host. Native Windows/DACL and `run_durable` acceptance are not
  established; `run_durable` remains gated behind DEC-V1-17.
- Task 5 added crate-private ArtifactStore storage with 256 MiB max payloads and bounded
  authorized chunks. Review follow-up hardens uncertain publication retry and cleanup error
  semantics. Current fresh verification: 70 unit + 11 golden + 25 recovery tests (106 total;
  0 doctests), `cargo fmt --manifest-path kernel/Cargo.toml -- --check`, strict host Clippy,
  and `git diff --check` passed. This is not wired to a production owner; Windows fails closed
  pending DACL validation; sensitive/state-key artifacts remain unavailable.
- Task 5 exact changes: `.gitignore:47`; `arch_V1/04-STATE-EVENTS.md:24`,
  `arch_V1/13-COMPOSITION-IPC.md:460-465`, `arch_V1/18-OPERATIONS-RELEASE.md:17-26`;
  `docs/superpowers/plans/2026-10-09-horizon-p2-foundation.md:143-160`;
  `docs/superpowers/specs/2026-10-09-horizon-p2-kernel-foundation-design.md:163-180`;
  `kernel/src/lib.rs:3-16`; and the new `kernel/src/artifact_store.rs:1-1433` module/tests.
- Remaining P2 scope: canonical Thread transitions; supervisor/owner epoch; Core V2
  ThreadStoreService adapter; one-to-one Session import/rollback snapshot; projection
  replay/rebuild/snapshot/resnapshot; supervised crash/restart acceptance.
- Discovery confirmed there is no existing ThreadService, ThreadStoreService, Kernel
  executable, RPC client/dispatcher, Unix peer adapter or supervisor. OpenCode Core V2's
  `SessionStore` reads SQLite and `SessionV2.prompt` commits via SQLite-backed `EventV2`, so
  P2 needs a complete durable-write cutover plus projection replay—not a read-only adapter.
- User-provided OpenCode V2 Session rules are incorporated: preserve process-local
  SessionExecution/SessionRunCoordinator, admission-before-wake and `resume:false`, exact
  prompt-ID retries, native Core runner/tools, one provider call per turn, and no automatic
  post-crash provider retry.
- New proposed plan: `docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md`, with a
  preflight gate plus eight delivery tasks. Self-review added exact Thread append/snapshot/
  replay seams, ToolBatch/result-link ownership, independent projection cursors (no lossy
  `UInt64Decimal` → JS `number` conversion), and the supplied Core/Schema/HttpApi constraints.
  It remains proposed; no product code has changed in this continuation.
- Preflight found unresolved architecture prerequisites: canonical Project identity ownership
  is absent from the owner table; `ThreadV1` requires a ProfileRevision and active ContextEpoch
  (P5/P3 own related capability); prompt input requires authorized ArtifactRefs but ArtifactStore
  is currently only a primitive with no production Artifact/Guard owner; the stable
  `host_instance_id` source also needs confirmation. Do not synthesize values or allow-all
  authorization. User must decide whether a minimal contracted prerequisite slice is in P2 or
  those dependent operations stay unavailable and P2 remains open.
- User-supplied `opencode/AGENTS.md`, `packages/schema/AGENTS.md`, and the OpenCode route guide
  are reflected in the plan: preserve V2 coordinator semantics and exact Schema identity; put
  stable Effect services at application layer assembly, never in route handlers; add no public
  HttpApi/SDK route for private Kernel RPC.
- The working tree also retains the earlier uncommitted Task 5 checkbox/evidence update in
  `docs/superpowers/plans/2026-10-09-horizon-p2-foundation.md`.
- User directed stopping implementation for today and updating the relevant plan/handoff and
  `arch_V1` documentation before a documentation-only commit/push. The P2 prerequisite scope
  decision is deferred; it has not been resolved or treated as approval to expand P2.
- Documentation checkpoint changed `.gitignore`, `arch_V1/10-DELIVERY.md` (P2 preflight
  dependency gate), `docs/superpowers/plans/2026-10-09-horizon-p2-foundation.md` (Task 5
  verification/commit checkboxes), and added
  `docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md` (preflight plus eight
  delivery tasks). Local-only handoff files `CURRENT_RUN.md` and
  `.slim/deepwork/p2-continuation.md` are updated but intentionally ignored by Git.
- Fresh documentation verification: `git diff --cached --check` and `git show --check` on
  `a22f810da` passed; staged review confirmed only the four named documentation/allowlist
  paths. No code tests were run because this checkpoint changed only Markdown and `.gitignore`.
  Push succeeded and `origin/p2-foundation` now tracks the current branch.

### Next Exact Steps

1. After the user resumes, obtain review of `docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md`
   and resolve the preflight scope decision: authorize only the minimum canonical Project/
   Profile/ContextEpoch/Artifact/authorization prerequisites in P2 with `arch_V1/` contract
   updates, or keep the dependent Session capability unavailable and leave P2 acceptance open.
   Do not implement before this decision.
2. After decision, update the plan and governing `arch_V1/` contracts, then execute preflight
   and Tasks 1–7 with regression-first tests and coherent commits; keep P0/Windows blockers
   visible.
3. Run the complete P2 gate and independent whole-branch review. Only after all requested gates
   pass, merge `p2-foundation` into local `main`, verify the merged tree, then push `main`.

### Decisions & Gotchas

- `opencode/` is an exact source snapshot in a subdirectory, not an OpenCode-derived root
  commit. P0 archival and root-base gates remain unsatisfied.
- Cache/index state is never authoritative: replay rebuilds it from OwnerLog V2 and exact
  retries/old cursors fall back to the canonical log if the derived index is unavailable.
- Owner locks coordinate cooperating opens, not arbitrary same-identity filesystem writers;
  pre-append replay detects prior edits but is not an anti-race/anti-tamper boundary. It costs
  O(retained history) I/O per append and remains a performance risk for long-lived streams.
- UI files are not in scope; follow `opencode/packages/ui/AGENTS.md` if that changes.

## Prior checkpoint — P2 Task 4 OwnerLog V2 (2026-10-10)

### Active Goal

Continue the approved P2 Task 4 implementation: OwnerLog V2 append, committed-head
recovery, delivery idempotency, and targeted verification. This does not claim P2 phase
acceptance or native Windows/durability acceptance.

### Where We Stopped

- Branch `p2-foundation`, base/current `HEAD=2eebe9b06ef97c195a2ad1f5293f1821a07c122a`;
  no Task 4 commit was created. Task 4 edits remain uncommitted. `origin/main` is
  `96cabbf25d3bd2f7500aef8f9a669046ce832545`; no push was performed.
- Edited `.gitignore`, `arch_V1/04-STATE-EVENTS.md`, `arch_V1/18-OPERATIONS-RELEASE.md`,
  `docs/superpowers/plans/2026-10-09-horizon-p2-foundation.md`,
  `docs/superpowers/specs/2026-10-09-horizon-p2-kernel-foundation-design.md`, and
  `kernel/src/owner_log.rs`; added `kernel/tests/owner_log_recovery.rs`. The local ignored
  ledger `.superpowers/sdd/2026-10-09-horizon-p2-foundation/progress.md` is also updated.
- Implementation includes multiple deliveries per active segment, replay-validated segment
  summaries for pagination, canonical command hashing and exact-retry receipts, torn-tail
  preservation/rotation, Unix owner-only directory/file modes, v1-only event schema checks,
  and failure recovery for both in-place append and rotation. Sync failpoints now inject I/O
  failures at the actual file/directory sync boundaries and exercise production error mapping
  and fencing.
- Windows OwnerLog currently fails closed with `StoragePermissionsUnavailable` until trusted
  state-root DACL validation is integrated. `run_durable` remains unavailable on Windows.
- Independent read-only review found no Critical issue and one unresolved Important issue:
  the in-memory delivery receipt map and segment summary vector grow with lifetime history.
  No architecture contract defines an owner history cap/retention policy. Per the user's
  direction, this is recorded as a missing P2 implementation in `arch_V1/10-DELIVERY.md`
  and the Task 4 plan. Do not evict old delivery identities or invent a hard cap; provide a
  rebuildable derived index or an explicitly contracted cap in follow-up work.
- Fresh evidence: `HORIZON_OWNER_LOG_TEST_TMPDIR=/tmp/opencode cargo test --offline
  --manifest-path kernel/Cargo.toml` passed 72 tests (45 unit, 11 golden, 16 recovery; 0
  doctests). `cargo fmt --manifest-path kernel/Cargo.toml -- --check`, host strict Clippy,
  Windows-target `cargo check --all-targets --features blake3/pure`, Windows-target strict
  Clippy, and `git diff --check` passed. These are not native Windows runtime, ACL,
  crash/power-loss, `run_durable`, or release evidence.

### Next Exact Steps

1. Implement bounded lifetime replay/pagination state (prefer a rebuildable derived index)
   and add tests for exact retry after reopen, index rebuild/corruption, and bounded memory.
   If a hard cap is chosen instead, first record its contract and test fail-closed behavior.
2. Request a final independent review and rerun the full Kernel, formatting, strict Clippy,
   Windows-target compile/lint, and diff checks.
3. Commit the verified Task 4 change as `feat(kernel): persist owner log commits`; do not push
   unless explicitly requested. Then continue the remaining P2/P1/P4 gates without claiming
   phase acceptance.

### Decisions & Gotchas

- The event schema registry in this foundation currently accepts only schema version 1.
- Windows ACL validation is deliberately not inferred from inherited defaults; OwnerLog stays
  unavailable there until a trusted root validator exists. Cross-compilation is not runtime
  evidence.
- A page read now validates only replay-indexed segments it touches, but the replay index and
  idempotency map themselves remain lifetime-sized; this is explicitly recorded as missing
  implementation rather than an accepted history-cap decision.
- Relevant architecture remains `arch_V1/04-STATE-EVENTS.md` and
  `arch_V1/18-OPERATIONS-RELEASE.md`; P0 provenance/base and DEC-V1-17 gates remain open.

## Prior checkpoint — P1/P2/P4 continuation (2026-10-09)

### Active Goal

Continue P1 Composition, P2 Kernel/Thread, and P4 Repository Intelligence/Memory to their
architecture-defined gates. The user approved proceeding with the OwnerLog V2 / shared
ArtifactService / handshake design; bounded codecs and primitives are not phase acceptance.

### Latest continuation — 2026-10-09

#### Where We Stopped

- Current branch is `p2-foundation`, at `2eebe9b06ef97c195a2ad1f5293f1821a07c122a`,
  15 commits ahead of `origin/main`; working tree was clean after the verified Task 3
  commit. The branch is local and has not been pushed.
- Committed Task 1 (`550682d`) amended the normative OwnerLog V2 migration and startup
  handshake contracts in `arch_V1/04-STATE-EVENTS.md`, `09-SOURCE-MAP.md`,
  `10-DELIVERY.md`, `13-COMPOSITION-IPC.md`, `17-GOVERNANCE-DECISIONS.md`, and
  `18-OPERATIONS-RELEASE.md`; it also updated root `AGENTS.md` with the P0–P9 roadmap and
  the rule that goal-control ownership errors do not block ordinary authorized work.
- Committed Task 2 (`d22eca2`) added `KernelHelloResultV1`, typed hello rejection,
  `STARTING`/`READY`/`FAILED` wire statuses, fixed wire vectors, nonce/incarnation binding,
  and a startup application-RPC admission helper. The helper is **not connected** to a
  transport dispatcher or supervisor yet.
- Committed Task 3 (`2eebe9b`) added pinned `blake3 = 1.8.7` and `serde_json = 1.0.150`,
  `kernel/src/owner_log.rs`, and the shared golden fixture/test. It implements bounded
  canonical record/head/seal codecs and digest checks only; it does not open files, lock
  owners, append, recover, or establish durability. The `interactive_only` head label is
  not evidence of a supported or accepted backend.
- Task 3 refined the normative physical field order and self-excluding head digest in
  `arch_V1/04-STATE-EVENTS.md` and the approved design spec. Duplicate raw JSON key rejection
  remains for Task 4's byte decoder because a `serde_json::Value` cannot represent duplicate
  keys.
- Verification after Task 3: `cargo test --offline --manifest-path kernel/Cargo.toml`
  passed 54 tests (43 unit + 11 OwnerLog golden/invariant tests); Cargo doc-tests had 0
  tests. `cargo fmt --manifest-path kernel/Cargo.toml -- --check`, strict Clippy
  (`--all-targets -- -D warnings`), `git diff --check`, and 13 OwnerLog doc-consistency
  assertions passed. No Windows target/runtime or durability acceptance was tested.
- No P1/P2/P4 phase acceptance is claimed. P0 source provenance/OpenCode-base gates remain
  incomplete; DEC-V1-17 still gates Windows `run_durable`.

#### Next Exact Steps

1. Start Task 4 from `docs/superpowers/plans/2026-10-09-horizon-p2-foundation.md`: add
   byte decoding/replay, append/head commit recovery, delivery idempotency, fault-injection
   tests, and preserve uncommitted tails without truncation or promotion.
2. Use test-first evidence for every behavior; keep `run_durable` fail-closed on unsupported
   platforms and do not claim native Windows acceptance.
3. Continue Task 5 immutable artifact-byte storage behind the authorization seam, then
   review the full plan and record remaining ThreadService/supervisor/host-adapter work.
4. Keep P1/P4 owner integrations and P2 Thread import/projection/restart acceptance open
   until implemented and verified; keep P0 and DEC-V1-17 gates explicit.

#### Decisions & Gotchas

- User approval superseded the earlier handoff's request to wait for written-spec review;
  the amended `arch_V1/` contracts are now normative for this implementation.
- OwnerLog JSON event digests exclude the JSONL LF; segment digests include every committed
  record LF. Head digests exclude their own field and LF. Golden fixture bytes lock these
  preimages.
- `serde_json::Value` loses duplicate object keys during parsing; recovery must compare raw
  bytes against canonical re-encoding or use a duplicate-rejecting parser before accepting
  committed records.
- Keep the ignored `.superpowers/sdd/2026-10-09-horizon-p2-foundation/progress.md` ledger
  and this local `CURRENT_RUN.md` updated at task boundaries; neither is a product acceptance
  record.

### Where We Stopped

- Before the fresh-start request, local `main` was OpenCode
  `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`; finalized `arch_V1/` and HorizonCode
  root docs were overlaid but uncommitted. The legacy docs commit was
  `b5c6fc31aed03c5966cb9ceacb5a90435f941332`.
- On 2026-10-08 the user explicitly confirmed purging all six prior Git metadata paths:
  `.git`, `opencode/.git`, `repos/cline/.git`, `repos/codex/.git`,
  `repos/deepseek-harness/.git`, and `cline-probe/.git`. They have been removed; no
  working files were targeted. Verification found no remaining `.git` paths under the
  root, and `git rev-parse` no longer recognized it as a Git repository before the new
  repository was initialized.
- The exact pinned OpenCode source tree, `arch_V1/`, and HorizonCode root docs remain on
  disk. `cline-probe/` is now empty; other nested working trees remain. Local branch,
  tag, remote, and object-database metadata—including the only local legacy archive
  refs—were removed. Do not claim the P0 archive/source-provenance gate is satisfied.
- The user then requested initialization. Ran `git init -b main` at the root and
  verified branch `main`, zero tracked files, no commits, and no remotes. No files were
  staged and no commit was created. The original OpenCode files and Horizon overlay are
  now untracked in the new repository.
- The user requested GitHub origin setup, first commit, and push. `origin` is
  `git@github.com:sarv-projects/horizoncode.git`; the first commit is
  `0009178` (`docs: add finalized HorizonCode v1 architecture`) and was pushed to
  `origin/main`. It contains only `.gitignore` and `arch_V1/` (22 files). Verified local
  `main` tracks `origin/main`, with no non-ignored untracked paths or staged changes.
- Per user instruction, root `.gitignore` now uses a bootstrap allowlist: ignore all
  paths except `.gitignore` itself and `arch_V1/**`. Verified OpenCode source, root
  README/AGENTS/CURRENT_RUN, `.freebuff/`, and nested checkouts are ignored, while
  `arch_V1/README.md` is not. The local OpenCode tree remains on disk but is not in the
  pushed repository; a fresh clone is currently architecture-docs-only and will not
  build OpenCode until implementation/base files are intentionally unignored and added.
- Corrected stale archive claims in `arch_V1/README.md`, `08-RECONCILIATION.md`,
  `09-SOURCE-MAP.md`, `10-DELIVERY.md`, and `17-GOVERNANCE-DECISIONS.md`. The P0 archive
  and OpenCode-base gates are explicitly marked incomplete after the fresh-Git reset.
- Current GitHub `origin/main` contains only `.gitignore` and `arch_V1/`; local OpenCode
  source remains ignored. A fresh clone is docs-only and cannot build. There is no
  configured OpenCode `upstream` remote, no tracked OpenCode base commit, and no Horizon
  implementation commit.
- The v1 gap review found P0 incomplete (archive, exact OpenCode base, repo/path inventory,
  build/test/direct-prompt/generated-output/license provenance evidence). P1–P9 have no
  Horizon implementation/acceptance evidence in the new repo. See `arch_V1/10-DELIVERY.md`,
  `17-GOVERNANCE-DECISIONS.md`, and `18-OPERATIONS-RELEASE.md` for detailed gates.
- User narrowed immediate P0 work to requirements 3 and 4. `.gitignore` now also
  unignores root `AGENTS.md` and `README.md`; `CURRENT_RUN.md` and OpenCode source remain
  ignored. P0.3 root docs are updated locally and untracked; they are not yet in `main`.
  P0.4 added `9.7 to `arch_V1/09-SOURCE-MAP.md`: 2,949/6,629 paths have first-pass
  dispositions and 3,680 remain unclassified. P0.4 is explicitly incomplete. Neither
  workstream staged, committed, or pushed. User clarified that the two parallel phases
  after the P0 focus should be selected from P1–P9; P1 Composition and P2 Kernel/Thread
  were recommended and later started as bounded slices by explicit user instruction.
- User then explicitly asked to start, plan, check, and launch subagents for P1/P2.
  Checked P1/P2 delivery and composition/IPC contracts, local package/source layout,
  available Cargo/Rust toolchain, and exact ignore exceptions. Added narrow `.gitignore`
  exceptions for only P1's new Core resolver/test files and P2's new `kernel/` crate
  files. P1's pure candidate graph resolver in `packages/core/src/composition.ts` plus
  `packages/core/test/composition.test.ts` completed in session
  `ses_ee2da4823ffeKCRZKu5lvd7FoX`; independent review confirmed the bounded scope, and
  local `bun test test/composition.test.ts` (6 passed), `bun run typecheck`,
  `bunx prettier --check src/composition.ts test/composition.test.ts`, and a 5,000-node
  deterministic-chain probe passed from `packages/core`. This slice still lacks SemVer
  ranges, manifest/capability validation, durable lock/CompositionService, and lifecycle.
  P2's std-only outer bounded frame codec in
  `kernel/Cargo.toml`, `kernel/src/lib.rs`, and `kernel/src/transport.rs` completed in
  session `ses_ee2da4821ffeqrGiI2PwDtFq2J`; independent review ran `cargo test` (6 passed),
  `cargo fmt --check`, and whitespace checks successfully. Scope excludes MessagePack,
  handshake, peer auth, RPC semantics, supervision, and Thread persistence. The review
  test generated a local `kernel/Cargo.lock`; build output is ignored.
- After the user approved another phase, checked P4 contracts and launched a third
  disjoint agent for an in-memory lexical index library under `indexd/` (session
  `ses_ee2d5e494ffebU7Hp6OMzZd47w`). Independent review ran `cargo test --offline` (10
  passed), `cargo fmt --check`, and whitespace checks successfully. The slice keeps
  generations/queries `PARTIAL`, pins overlays to immutable bases, validates relative
  paths, and uses bounded search. It is not a supervised process and does not access the
  filesystem or own workspace/canonical state. `indexd/Cargo.lock` is present.
- User explicitly corrected the scope: continue until P1/P2/P4 meet their full
  `10-DELIVERY.md` gates, rather than stopping after prototype slices. Activated the
  deepwork workflow and created ignored `.slim/deepwork/horizon-p1-p2-p4.md`; added
  `.slim/deepwork/` to `.gitignore` and created ignored `.ignore` exceptions so tools can
  read the progress file. The available reviewer agents are only `general` and `explore`,
  not the deepwork skill's named Oracle; use and record an independent general-review
  substitute. Three read-only explorers are active for P1 host composition
  (`ses_ee2afb130ffeAt61UUMf35UxzQ`), P2 Thread/storage/source seam
  (`ses_ee2afb11cffeQYrQ6eSV7xrRmb`), and P4 index/memory integration
  (`ses_ee2afb112ffeg8FfDhc6k68HDq`). No new phase implementation has started after this
  scope expansion. DEC-V1-17 gates Windows `run_durable`; archive/source-base P0 remains
  incomplete, and old `horizoncode-eventlog` source must not be replaced by a parallel
  store without verified recovery or an approved architecture change.
- Bun dependencies were installed. The attempted direct-prompt test failed at Bun's
  default 5-second timeout because the package's 30-second test timeout was not used;
  `bun run typecheck` was interrupted. No build was run. The architecture commit push
  succeeded.
- Current continuation edited `.gitignore` lines 1-72; `packages/core/src/composition.ts`
  lines 1-818 and `packages/core/test/composition.test.ts` lines 1-314;
  `packages/core/src/composition-manifest.ts` lines 1-298 and its test lines 1-217;
  and earlier slices of `packages/schema/src/composition-v1.ts`, its tests,
  `kernel/src/messagepack.rs` lines 1-932, `kernel/src/protocol.rs` lines 1-1423,
  `kernel/src/lib.rs` lines 1-12, and new `kernel/src/startup.rs` lines 1-250. The latest
  increment touched `packages/schema/src/composition-v1.ts` lines 256-287 and
  `packages/schema/test/composition-v1.test.ts` lines 124-151, adding semantic
  HookContributionV1 checks and focused tests, plus the in-process startup readiness gate.
  Also updated local-only `.slim/deepwork/horizon-p1-p2-p4.md` and this handoff. Changes
  were uncommitted and unstaged at the prior handoff. On 2026-10-09 the user explicitly
  requested add/commit/push of those bounded slices before continuing. Commit
  `3b584c6` (`feat(horizon): add bounded P1 P2 P4 prototypes`) was pushed to `origin/main`;
  `git rev-parse origin/main` matched `3b584c624695ff71d93ea5f4370778f14b18a400`. The
  OpenCode base remains excluded. The current Windows peer-auth increment is local,
  unstaged and uncommitted; `kernel/src/windows_peer.rs` is explicitly allowlisted.
- P1 now has direct schemas, schema-first manifest preflight/validation, SemVer resolver,
  trusted singleton/priority/sealed replacement policy, and deterministic bounded graph
  resolution. P2 now has typed MessagePack/HzKernelRpcV1 wire decoding, canonical body
  encoding, v1-only negotiation, frame/body/depth/collection caps and safe-integer checks.
  A `cfg(windows)` named-pipe adapter now generates 128-bit names with the system RNG,
  uses a protected logon-SID DACL plus remote-client rejection, binds before child launch,
  then pins the expected process handle; it verifies PID, creation time, user/session/logon
  SIDs and executable-path policy before returning the exact stream. Its synchronous
  listener has no cancellation path and same-logon peers can still cause denial of service.
  Review findings were fixed, including bounded pre-decode target lists, exact hook-lock
  resolution checks/reasons, and linear hook-resolution lookup. Oracle review was
  unavailable; a general reviewer completed one review plus two re-reviews, and its final
  findings were remediated with focused tests. The review budget is exhausted.
 - Latest evidence: schema 7 tests + typecheck + Prettier pass; Core 15 tests + typecheck +
   Prettier pass; kernel 24 offline tests + fmt + warning-free Clippy pass; indexd 10
   offline tests + fmt pass. Kernel Windows `cargo check --tests` and warning-free Clippy
   passed for `x86_64-pc-windows-msvc`, but this only cross-compiles the adapter/tests; no
   Windows test ran. A parallel rerun once caused the Core 8,000-node test to hit Bun's
   5-second default timeout; isolated and serial runs passed. Microsoft Learn review found
   the default pipe DACL broad, `FILE_CREATE_PIPE_INSTANCE` required for pipe creation, and
   logon SID necessary to isolate terminal sessions; sources are in
   `.slim/deepwork/horizon-p1-p2-p4.md`. These checks verify bounded slices only. P1/P2
   remain partial: no durable CompositionService or Thread owner, integrated/authenticated
   supervisor lifecycle, idempotency/replay, canonical event-log persistence, or Windows
   runtime acceptance. P4 remains a partial in-memory index; source acquisition and
   MemoryService remain behind authenticated IPC and WorkspaceService/Guard authorization.

- 2026-10-09 continuation added `.gitignore` allowlisting for `kernel/src/windows_peer.rs`,
  Windows-only `windows-sys` dependencies in `kernel/Cargo.toml`/`Cargo.lock`, module
  export and crate status text in `kernel/src/lib.rs`, and the Windows adapter in
  `kernel/src/windows_peer.rs` (currently 800+ lines). `indexd/src/lib.rs` now has
  exhaustive KMP-vs-naive coverage and immutable per-file overlay replace/clear operations;
  `indexd/src/README.md` documents the bounded overlay behavior. These source changes
  remain unstaged/uncommitted.
  `cargo test --offline` passed 24 Linux kernel tests; `cargo fmt --check`, Linux
  warning-free Clippy, Windows-target `cargo check --tests`, and Windows-target
  warning-free Clippy all passed. `indexd` passes 14 offline tests, fmt and warning-free
  Clippy. Six `cfg(windows)` tests compile but none ran on Windows.
- Per the user's 2026-10-09 request, three read-only agents were launched; all have
  returned and none edited files. Their findings are recorded below and in the deepwork
  handoff; no formal code review was requested, preserving the exhausted review budget.
- P2 lifecycle agent `ses_ee0c9e40effe09h9CKHL5kCXxc` returned read-only findings: current
  protocol only defines one-sided `hello` plus pure negotiation; `13.3 does not specify a
  negotiated-result/hello-ack message. `StartupGate` still trusts caller-reported
   milestones, and there is no supervisor/lifecycle integration. Do not invent the missing
   wire response; an architecture decision is required before handshake integration. Real
   epoch/recovery/shutdown also remain blocked by the missing event-log source/contract.
- P1 digest agent `ses_ee0c9e964ffeYUIwS1BrYZPUF0` returned read-only findings:
  CompositionService validates/pins contribution refs, ArtifactService owns immutable
  bytes/digests, but no ArtifactService implementation is present. General canonical
  persisted-payload rules do not specify HookContribution artifact bytes or the
  CapabilityRequestV1 digest preimage. Do not add hashing to Core or reuse indexd's
  domain-specific BLAKE3; golden byte/digest fixtures and the canonical preimage/encoding
  decision are required before byte validation.
- P4 acquisition agent `ses_ee0c9e3e0ffeSbMxavLDYCfSYE` returned read-only findings:
  pure snapshot-fed index tests can proceed, but production reads require authenticated
  IPC dispatch, Guard, WorkspaceService canonical lease/fence/revision checks and
  ArtifactService byte transfer. MemoryService is a canonical kernel owner, not indexd.
- Added immutable `BufferOverlay::replace_file` / `clear_file` operations, bounded content
  accounting, and tests for base immutability, digest parity with a full snapshot,
  aggregate byte/file caps, and stale-base rejection. Along with exhaustive KMP-vs-naive
  coverage, `indexd/src/lib.rs` has 14 passing offline tests, fmt, and warning-free Clippy.
  This proves only bounded pure snapshot behavior, not repository completeness or P4
  production readiness.
- Added bounded atomic `OverlayChange` batches via `BufferOverlay::apply_changes` in
  `indexd/src/lib.rs`, with exact-base validation, unique existing paths, a 128-change
  cap, bounded replacement/final content, and a single deterministic digest recompute.
  `indexd/src/README.md` documents the behavior. Tests prove digest parity with full
  snapshot construction, order-independent output, and unchanged prior overlays on
  invalid-input, duplicate-path, change-count, and aggregate-byte failures. From
  `indexd/`, `cargo fmt`, `cargo test --offline` (17 passed),
  `cargo clippy --offline --all-targets -- -D warnings`, and `cargo fmt --check` all pass.
  This remains a pure caller-snapshot transformation: pins are opaque and no workspace
  publication, authorization, process, scheduling, or P4 production readiness is implied.
- Continued P1 in `packages/core/src/composition-manifest.ts` with non-authoritative
  preflights that require a decoded contribution locator to exactly match a declared
  manifest `contributionRef`, match contribution plugin/version/package identity, reject
  more capability-request digests than declared requests without pretending to match
  unresolved preimages, bind a global hook binding to its contribution and declared event,
  and check fixed HookResultV1 shape, BLOCK-vs-event mode, and declared reason-artifact
  length. These helpers do not verify artifact bytes/digests or schema-registry identity,
  execute hooks, enforce adapter guarantees, grant capabilities, or replace owner checks.
- P1 verification from `packages/core/`: `bun test test/composition-manifest.test.ts`
  passes 14 tests; `bun run typecheck` and Prettier checks for the changed files pass.
- Continued P2 with fixed MessagePack V1 wire vectors for all five RPC controls, including
  `subscribe` cursor omission/presence, plus negative supervisor-nonce and process
  incarnation negotiation tests. The unknown-required-feature fixture now uses the
  expected process incarnation so it exercises that feature check. Kernel Linux tests
  pass 25; fmt, warning-free Clippy, Windows-target test compilation, and Windows-target
  warning-free Clippy pass. No Windows runtime tests ran.
- P4 atomic batch overlay increment was implemented by subagent
  `ses_ee0944470ffekSVZkdMfFZir8s`; its changes are in `indexd/src/lib.rs` and
  `indexd/src/README.md`. Verification was rerun locally: 17 offline tests, fmt, and
  warning-free Clippy pass. The implementation remains pure caller-snapshot behavior.
- P2 read-only assessment `ses_ee0944459ffethHUSam3r0IQu1` found no safe substantive
  lifecycle/persistence increment without the missing hello-response contract/event-log
  source; its safe protocol test recommendations were implemented above. The user
  explicitly reiterated that P1/P2/P4 must continue to their gates and independent work
  should use subagents; these additions are not phase completion.
- Continued the mandated event-log source-recovery check: no
  `horizoncode-eventlog/Cargo.toml` exists under this repository or the surrounding
  `/home/sarvesh/business_Dev` tree; the public crates.io API returned 404, and the known
  GitHub commit API lookup returned 422. This did not recover or verify source; do not
  implement persistence or a replacement format from these results.
- Continued recovery through MCP: GitHub `get_file_contents` confirms current
  `sarv-projects/horizoncode` `main` is the architecture/bootstrap repository, while the
  `legacy-horizoncode` ref has no commit; MCP `git_clone` could not find that branch or
  `pre-opencode-rebase` tag. GitHub code search requires authentication. Exa search found
  unrelated event-log projects only. No legacy source or physical contract was recovered.
- P1 lock-schema relation was extended: every `RESOLVED` global hook's contribution digest
  must appear in a selected `CompositionLockV1.nodes[].contributionDigests`. Focused test
  rejects missing/mismatched pins and accepts a matching selected-node pin. The change is
  present in current `HEAD` `96cabbf`; targeted schema test/typecheck/Prettier passed. The
  full schema suite reports two failures in untouched event-manifest tests (expected event
  count 55 vs 58 and event-order mismatch); investigate whether they are baseline/source
  tree drift before treating schema verification as clean.
- Investigated that full-suite failure in the ignored local OpenCode schema snapshot:
  `event-manifest.test.ts` expects 55 server definitions, 85 total definitions, and 32
  durable events, but the loaded source currently yields 58, 88, and 35. The current
  server inventory includes three `session.next.revert.{staged,cleared,committed}` events
  before the expected `message.part.delta`/`session.diff` positions. The test/source files
  are ignored OpenCode substrate paths, not changed in this Horizon increment; keep the
  discrepancy explicit and do not edit the upstream test to make it green. It is evidence
  that the local pinned-source working tree has drifted from that test's expectation.
- Parallel agents completed: P1 lock-schema cross-check
  `ses_ee06cd160ffeQ8lGnDk25kM07H`; P2 Windows path hardening
  `ses_ee06bc600ffenlzPSX4bDtZalC`; P4 query pagination
  `ses_ee06b9b3affeF6rUvJIU95P5tB`; P4 memory contracts
  `ses_ee0682feeffebhunO49h5ZUVbe`; P4 repo-intelligence contracts
  `ses_ee059c490ffejBciis9L225LQt`; P1 selected global-hook binding preflight
  `ses_ee0597ca8ffeT1H5Yo4SkTu7UL`. Agents were told not to commit or edit this handoff.
- At fresh inspection, `HEAD` and `origin/main` both resolve to
  `96cabbf25d3bd2f7500aef8f9a669046ce832545` (subject `commit`, author `sarvesh`); this
  assistant did not create that commit. Current worktree modifications are in
  `indexd/src/lib.rs`, `indexd/src/README.md`, and `kernel/src/windows_peer.rs`; preserve and
  inspect them rather than resetting or overwriting.
- Continued P1 Core preflight in `packages/core/src/composition-manifest.ts` with
  `preflightSelectedHookContributions`: composes existing manifest/ref/identity checks,
  rejects duplicate `hookId` values across the selected candidate set, applies the existing
  policy-entry count bound, and returns only bounded diagnostics on invalid members.
  Core now also has `preflightSelectedGlobalHookBindings`: it preserves input order,
  validates unique bindings/ordinals and per-event ordering, resolves declared events,
  fails required absence, and reports optional absence only as a non-persistable local
  status. It does not synthesize persisted reasons/digests. Core verification passes 34
  tests across `composition.test.ts` and `composition-manifest.test.ts`, typecheck, and
  Prettier. These checks remain non-authoritative and verify no bytes/digests.
 - Continued P2 in new `kernel/src/request_cancellation.rs`: a per-connection bounded
   registry (caller-supplied `NonZeroUsize` capacity) registers active request IDs, routes
   idempotent advisory cancellation to cooperative atomic tokens, rejects duplicate/invalid
   IDs and capacity overflow, and unregisters by RAII guard. It performs no dispatch,
   authentication, rollback or effect cancellation. `kernel/src/lib.rs` documents the
   boundary, and `.gitignore` narrowly allows this module. It also routes decoded
   `RpcControlV1::CancelRequest` controls to the matching active registration; other
   controls are left to their dispatcher. Verification after cancel/finish,
   control-routing, and cross-connection isolation tests: 31 offline Linux tests, fmt,
   warning-free Clippy, Windows-target `cargo check --tests`, and Windows-target
   warning-free Clippy pass. Windows runtime tests remain unrun.
- Continued P2 Windows path-policy hardening in `kernel/src/windows_peer.rs`: process-image
  comparison now requires exact bounded UTF-16 spelling instead of ordinal case-insensitive
  comparison, avoiding a case-sensitive-directory alias. The module is `cfg(windows)`, so
  its exact-path regression tests were compiled for the Windows target, not executed on
  Linux. Linux kernel tests/Clippy and Windows-target test compilation/Clippy pass; native
  Windows runtime acceptance is still required.
- Added direct P2 wire contracts in `packages/schema/src/thread-v1.ts` for the canonical
  Thread ID and Cursor V1, profile/model selection refs, `ThreadV1`, `ThreadInputV1`, and
  `InputAdmissionRequestV1`. These are shape contracts only; they do not implement
  ThreadService, admission, lifecycle, authentication, or event-log persistence. The P4
  memory schemas now reuse the canonical `ThreadId` and `CursorV1` values rather than
  defining competing identities. `thread-v1.ts` defines ThreadId, ProjectId, InputId,
  DeliveryId, TurnId, Run/Task/Attempt IDs, ContextEpochId, AgentProfileId, CursorV1,
  ProfileRevisionRefV1, ModelSelectionV1, ThreadV1, ThreadInputV1, and
  InputAdmissionRequestV1. Focused composition/memory/repo/thread schema tests pass 20
  tests (130 assertions), typecheck and Prettier.
- Continued P4 query work in `indexd/src/lib.rs` with stable path/line search cursors bound
  to query, base-generation and optional overlay digests. Tokens are bounded/versioned and
  checksummed (not authenticated); cursor mismatch, missing anchor, and work exhaustion
  before anchor fail explicitly. Pagination scans deterministically from the start within
  the normal work budget. Indexd verification now passes 21 offline tests, fmt and
  warning-free Clippy.
- Continued P4 Memory at the wire-contract layer with new direct specialized
  `packages/schema/src/memory-v1.ts` and focused tests covering `12.12 records, scopes,
  candidates, queries, extraction and consolidation. It reuses canonical shared schema
  values from `composition-v1.ts`; IDs carry the required schema identifiers (annotation
  precedes `check` so Effect v4 does not attach the identifier only to a filter). Schema
  checks also enforce nonnegative integer counters/bounds, ascending ThreadRangeRef bounds,
  tombstone timestamp/status consistency, operator-approved candidate links, accepted
  candidate review receipt/link, extraction/thread and consolidation/scope consistency,
  extraction cursor owner-kind/owner-ID binding to its Thread, and typed failures on FAILED
  extraction/consolidation. Added direct
  `repo-intelligence-v1.ts` wire contracts
  for revision refs/sets, generations, queries and results; revision-set ordering remains
  owner-validated because RepositoryId collation is unspecified. Both entrypoints are
  schema-only and do not implement owners, authorization, retrieval or digest computation.
   The root allowlist narrowly permits the six new Schema files. Focused tests pass 20
   tests across composition-v1, memory-v1, repo-intelligence-v1, and thread-v1 (132
   assertions after the cursor-owner fix), typecheck and Prettier. Full schema `bun test`:
   33 passed, 2 unchanged
  `event-manifest.test.ts` tests failed: local ignored-source inventory is 58/88/35 while
  tests expect 55/85/32; three `session.next.revert.*` entries shift the expected order.
- Existing P1/P2/P4 changes are unstaged/uncommitted after `HEAD` `96cabbf`; do not reset or
  overwrite them. Current changes include `.gitignore`, indexd README/lib, kernel Cargo/lib,
  kernel Windows peer, new kernel cancellation module, Core composition preflight/test,
  and new memory/repo-intelligence/thread schema/test files. All active agents have returned.
  None of this satisfies P1/P2/P4 phase gates.
- Exceptional independent reviewer `ses_ee03e88acffe8HNJhzCPzeTIml` reviewed the combined
  batch and found one material P2 contract gap: `MemoryExtractionV1.sourceRange.threadId`
  matched `threadId`, but `sourceCursor.ownerKind/ownerId` were not bound to that same
  Thread. Fixed `packages/schema/src/memory-v1.ts` to require ownerKind `thread` and
  ownerId equal to `threadId`, with negative tests for both mismatches in
  `packages/schema/test/memory-v1.test.ts`. No other material code issue was reported.
  Post-remediation focused Schema tests pass 20 tests/132 assertions, typecheck and
  Prettier; full package suite remains 33 pass/2 unchanged ignored event-manifest failures.
  The reviewer did not rerun suites; local focused and full runs provide post-fix evidence.
  The review and this bounded remediation do not satisfy P1/P2/P4 phase gates.
- Exact latest edited regions include `.gitignore` lines 19-38; `indexd/src/lib.rs`
  `BaseGeneration::search_page*` lines 279-420, cursor codec/types around 756-1150, and
  pagination tests around 1490-1635; `indexd/src/README.md` lines 16-23, 54-63; kernel
  cancellation routing/tests in `kernel/src/request_cancellation.rs` lines 1-327 and
  `kernel/src/lib.rs` lines 3-18; Windows path policy in `kernel/src/windows_peer.rs`
  lines 15-46, 732-750; Core selected contribution/global binding preflights in
  `packages/core/src/composition-manifest.ts` lines 44-130, 203-414 and tests in
  `packages/core/test/composition-manifest.test.ts` lines 364-542; Schema modules and
  tests in `memory-v1.ts`/test (1-241/1-352), `repo-intelligence-v1.ts`/test (1-73/1-212),
  and `thread-v1.ts`/test (1-543/1-659). `CURRENT_RUN.md` and
  `.slim/deepwork/horizon-p1-p2-p4.md` also record this handoff.
 - Platform question: the normative contract is Windows-first. WSL may execute a worker,
   while canonical state remains on the Windows user-data root
   (`arch_V1/18-OPERATIONS-RELEASE.md`). This does not promise a native Linux desktop release
   or specifically Git Bash/MSYS; WSL worker support is not implementation/acceptance
   evidence yet and must not be advertised as shipped.
- Latest continuation after the above handoff added P2-only wire contracts in
  `packages/schema/src/thread-v1.ts` and focused tests. The direct V1 module now also
  models legacy Session aliases/import origins, immutable UNKNOWN historical Turn imports,
  canonical live/historical Turn and ProviderAttempt unions, historical provider
  reconciliation links, uncertain-operation import links, `TurnOperationsReconciledV1`,
  and all `12.3 `MessageV1`/`MessagePartV1` variants. Import admission/reconciliation
  cursors are checked against their declared Thread stream; these shape checks do not
  authenticate migration, prove message trust, authorize dispatch, or settle effects.
  `RetryClassV1` was promoted to the shared Composition schema and `TypedErrorV1` now uses
  that exact schema value rather than duplicating the literal union. Focused V1 Schema
  tests pass 20 tests/177 assertions, typecheck and Prettier pass. Full Schema remains
  33 passed/2 unchanged ignored-substrate event-manifest failures (local source inventory
  58/88/35 versus 55/85/32 expected).
 - Continued P2 logical event-payload contracts in the new direct entrypoint
   `packages/schema/src/event-payload-v1.ts`: `EventPayloadMetadataV1`,
   `AggregateTransitionV1`, and event/correlation IDs follow `12.1. Shared `ActorRefV1` now
   lives in `composition-v1.ts` and is reused by Thread messages and event metadata. These
   are logical shapes only; no physical event-log row/segment, canonical encoding, digest
   calculation or persistence behavior was added. The aggregate schema also checks the
   explicit creation invariant `fromState: ABSENT` implies `expectedVersion: 0`. Focused
   V1 Schema tests pass 23 tests / 189 assertions; typecheck and Prettier pass.
- Latest P4 agent increment concluded `max_results` is per-page, not part of cursor query
  identity; varying page sizes preserve contiguous path/line continuation. Added a
  regression and README contract in `indexd/src/lib.rs` and `indexd/src/README.md`.
  A read-only P4 subagent found a separate coverage gap: existing generation tests did not
  explicitly prove snapshot path/content changes alter generation identity. Added a test
  asserting same snapshot/pins reproduce a digest while changed bytes or path change it;
  `indexd/src/README.md` now documents this as implementation behavior, not a canonical
  architecture digest preimage.
  Current verification: Indexd 23 offline tests, fmt and warning-free Clippy pass.
 - Latest P1 dependency-check agent made no edits: no concrete kernel-store import API or
   managed Task/worker PASS setter exists in the permitted source tree, and existing
   `packages/core/src/plugin/provider/openai.ts` calls `Effect.runFork`, making a literal
   provider-adapter ban fail against the pinned source. Do not add an ungrounded test or
   claim fresh-clone coverage while OpenCode files remain ignored. GitHub MCP repository
   searches for `horizoncode-eventlog` and `horizoncode eventlog` returned zero; GitHub code
   search requires authentication. The canonical event-log/handshake and P1 digest-byte
   blockers remain unresolved.
 - A separate read-only P1 scan found one schema-only coverage gap and no safe runtime
   increment: added a table-driven regression in `packages/schema/test/composition-v1.test.ts`
   covering all 11 hook events and both allowed/rejected modes. Only `before_start`,
   `before_tool`, `before_finish`, and `before_compaction` accept `BLOCKING`; the other seven
   accept only `OBSERVATIONAL`, matching `13.3. The single-file Schema check passes 9 tests/59
    assertions; the latest focused five-file V1 Schema suite passes 25 tests/222 assertions,
    typecheck and Prettier.
  - P1 validation of `capabilityRequestDigests` remains blocked: the canonical
   CapabilityRequest digest preimage and ArtifactService bytes are not available, and the
   P1 durable lock publication/activation/drain/quarantine lifecycle belongs to the absent
   CompositionService owner. The new matrix is schema evidence only, not a P1 gate claim.
  - A second P1 schema invariant is now implemented: `CompositionLockV1.activationOrder`
    must be a duplicate-free permutation of the selected node `pluginId` values. The schema
    also rejects duplicate selected node IDs, which cannot be represented one-to-one by the
    activation-order list. Tests cover valid reversed order, missing/repeated/unknown IDs,
    and duplicate node IDs; no activationOrdinal/index relationship is asserted. P1 runtime
    publication, activation and draining remain owned by CompositionService and unimplemented.
  - Added a P2 RPC regression that exercises the maximum encoded `TypedErrorV1` detail size
    at the 64 KiB boundary through `encode_message`; the largest accepted error encodes
    within the cap and the next message byte is rejected. This is codec evidence only, not
    a handshake or service integration.
  - Extended the P2 body-limit test to cover a response body whose MessagePack encoding is
    exactly 1 MiB, and a response body one encoded byte over; `encode_message` accepts/rejects
    those boundaries respectively. It also covers the exact 256 KiB event-payload boundary
    and one encoded byte over, alongside request oversize rejection. This is bounded codec
    evidence only.
  - P2 `subscribe.after` now must identify the same `ownerKind` and `ownerId` requested by
    the subscription. Tests accept a matching cursor and reject mismatches in either field.
    This validates only request-local identity; binding later events/acks to an active
    subscription remains stateful owner/runtime work.
  - P2 wire-boundary regressions now also assert the exact 768 KiB artifact chunk body is
    accepted and one encoded byte over is rejected, and exercise exact inclusive deadline
    maxima (5 minutes interactive; 24 hours durable-managed) plus one-millisecond-over
    rejection. No transport or owner behavior was added.
  - Added a P1 resolver regression proving `Number.MAX_SAFE_INTEGER` is a valid provider
    priority, while fractional, over-safe-range, infinite and NaN priorities produce
    `invalid_provider_priority`. The pure resolver remains candidate-only and does not
    authenticate trusted policy or commit/activate a lock.
  - Added a P1 resolver regression that an absent `optional: true` requirement does not fail
    resolution and creates no dependency edge; required missing services remain fatal.
  - P2 helper tests now prove `validate_operation_body` and `canonical_body_bytes` accept an
    encoded body exactly at a small trusted cap and reject at cap-minus-one, with canonical
    bytes pinned. A body one encoded byte over the global 1 MiB limit is rejected even when
    the supplied owner cap is larger, by both helpers.
  - The read-only P2/P4 dependency scan completed without edits or tests. P2 has bounded
    framing, MessagePack/RPC shapes, and pure hello negotiation, but no integrated
    supervisor, durable idempotency/owner cursors, ThreadStoreService, or verified
    `horizoncode-eventlog` source. `arch_V1/09-SOURCE-MAP.md:150-165` records historical
    paths absent from the tree; P2 requires source recovery or an approved migration and a
    decided handshake response/readiness authority. Native Windows peer/runtime and DEC-V1-17
    durability acceptance remain external platform gates.
  - P4 `indexd` remains an in-memory library over caller-supplied snapshots, not a supervised
    process, filesystem reader or RepoIntelService (`indexd/src/README.md:1-7`). Guard and
    WorkspaceService must authorize/source repository observations; ArtifactService owns
    bytes; kernel priority/cancellation and canonical RepoIntelService/MemoryService owners
    are absent. Existing pins/digests are implementation identities only, not authorization
    or canonical generation evidence. The scan found no source-backed increment that closes
    those service gates; pure schemas/index tests may continue.
  - P4 `RevisionSetV1` now rejects duplicate `repositoryId` members while preserving the
    supplied order. Architecture requires members sorted by RepositoryId but defines no
    collation for opaque IDs, so Schema enforces equality/uniqueness and leaves ordering to
    RepoIntelService. Tests cover distinct unsorted values and a duplicate. This does not
    validate revision digests or establish source authority.
  - P4 `MemoryRecordV1` rejects duplicate accepted `supersedesMemoryIds` while preserving
    order; sorting/collation and accepted-set freshness remain MemoryService responsibilities.
    `MemoryQueryV1` also rejects a generation reference whose `scopeId` is absent from the
    query's declared `permittedScopes` IDs. This is only necessary payload consistency: the
    ref has no scope kind, and Schema does not establish caller authorization or full scope
    ownership.
  - Added a P4 Indexd regression for continuation work exhaustion before a valid later-file
    cursor anchor. It verifies `CursorWorkLimit` instead of returning a potentially
    incomplete page; no search behavior changed.
  - A read-only P1 scan considered requiring lock providers/edge endpoints to reference
    selected nodes, but the normative contract lists `nodes`, `providers`, and `edges`
    without defining membership or excluding external providers (`13-COMPOSITION-IPC.md:
    167-175,321-348`). No such relation was added; this remains an owner/architecture decision.
  - Current goal remains active. Post-continuation verification: Core focused suites 36 pass,
    typecheck and Prettier; focused V1 Schema suite 25 tests/222 assertions, typecheck and
    Prettier; full Schema 38 pass/2 known event-manifest failures; Indexd 24 offline tests,
    fmt and Clippy; Kernel 34 offline tests, fmt and warning-free Clippy. Windows MSVC target
    `cargo check --tests` and Clippy pass; `cargo test --no-run` cannot link on Linux because
    `link.exe` is absent. No native Windows tests ran. Changes remain local and
    unstaged/uncommitted.
  - Exact latest spans: `packages/schema/src/thread-v1.ts:46-85,129-540` and
    `packages/schema/test/thread-v1.test.ts:32-658`; `packages/schema/src/event-payload-v1.ts:1-46`
    / test `1-111`; hook event/mode matrix in `packages/schema/test/composition-v1.test.ts:162-190`;
    activation-order invariant in `packages/schema/src/composition-v1.ts:405-416` and tests in
    `packages/schema/test/composition-v1.test.ts:349-378`; shared `ActorRefV1`/`RetryClassV1`
    in `composition-v1.ts` around 61-65 and 514-540. P2 cursor binding in
    `kernel/src/protocol.rs:353-372`, test `1353-1374`; body/chunk helper limits at `1460-1549`,
    deadlines at `1552-1561`, and typed-error size at `1590-1646`. P1 resolver tests at
    `packages/core/test/composition.test.ts:102-114,173-194`. P4 unique `RevisionSetV1` members
    in `packages/schema/src/repo-intelligence-v1.ts:36-51` and test near
  `repo-intelligence-v1.test.ts:197-221`; memory supersession/query scope checks in
  `packages/schema/src/memory-v1.ts:80-100,120-145`, tests in `memory-v1.test.ts:174-240`;
  Indexd cursor pagination tests in `indexd/src/lib.rs:1605-1708`, including
  `search_continuation_fails_if_work_limit_precedes_cursor_anchor` at 1685; generation
  identity regression near 1440 and README cursor contract at `indexd/src/README.md:60-69`.

- 2026-10-09 resumed continuation: the user explicitly resumed P1/P2/P4 with fresh limits
  and selected the existing `main` working tree rather than a separate worktree. Preserve
  all pre-existing dirty edits. `HEAD` remains `96cabbf25d3bd2f7500aef8f9a669046ce832545`;
  current status lists modifications to `.gitignore`, Indexd, Kernel, Core, and Schema plus
  new Kernel/Schema files. No edits in this continuation have yet changed implementation.
- Read-only OpenCode package reconnaissance completed across local `packages/{core,schema,
  protocol,server,client,sdk-next,opencode}` by agents `ses_edfbc381affefRRlYG1BqS7V4W`,
  `ses_edfbc39abffe655ODGk3PLudti`, and `ses_edfbc386cffeenVf3ZJV2AcxHn`. Generic substrate
  exists for typed EventV2/SQLite projections, Session input admission/history/scheduling,
  scoped plugin cleanup, HTTP/SSE and generated clients, bounded local search, Git snapshots,
  and context-source registration. No Horizon CompositionService, ThreadStoreService/private
  kernel owner transport, RepoIntelService, MemoryService or ArtifactService exists in those
  inspected packages. OpenCode's generic SQLite event store is not the required
  `horizoncode-eventlog` segmented committed-head format; its plugin/runtime and search
  seams are references only, not replacements for Horizon owners. The local OpenCode tree is
  ignored/untracked and has no nested `.git`, so its claimed pinned revision cannot be
  verified from local metadata.
- Repeated exact source recovery through Exa, Crawl4AI, GitHub MCP repository search,
  general web search, crates.io API, and narrowed local Cargo/OpenCode/business-workspace
  path searches found no `horizoncode-eventlog` source or matching public repository. The
  exact crates.io API and historical GitHub commit URL return 404; GitHub repository
  searches return zero, and exact web searches return no matches. These are search results,
  not authorization to replace or migrate the normative event-log format.
- DeepWiki MCP's `anomalyco/opencode` inventory independently lists generic EventV2/Session,
  plugin, repository-cache and file-storage facilities but no canonical Horizon service
  owners. Its broad description of file storage as artifact storage is not evidence of an
  immutable, content-addressed ArtifactService; direct local source inspection remains the
  more precise implementation evidence.
- Three read-only contract-audit agents returned to identify any remaining P1, P2, or P4
  schema/prototype increments that are explicitly specified and safe without inventing
  missing owner/artifact/handshake decisions: P1 `ses_edfb4efeaffevZtj3n3NZBzkyv`, P2
  `ses_edfb4ef02ffeMX9ardiNLxpr1I`, and P4 `ses_edfb4eec1ffeOvVqFbgA9Gbzny`. Their scope
  excluded edits and tests; the reports are recorded below and feed the next bounded
  implementations.
- The P1 audit returned without edits: uncovered test-only cases are ServiceOffer metadata
  mismatches/unknown definitions, `requires` vs `optionalRequires` flag consistency,
  selected-hook array cap-plus-one diagnostics, and empty explicit global-hook bindings
  producing no resolutions. Production lifecycle, bytes/digests, provenance verification,
  hook runtime, and ServiceDefinition/API-version mapping remain blocked or underspecified;
  do not infer `ServiceDefinition.apiVersion` to offer SemVer mapping.
- The P2 audit returned without edits: safe contract tests/checks are (1) reject hello
  negotiation when trusted expected process incarnation is missing, (2) bound logical event
  `schemaVersion` to `u16`, (3) make ABSENT/zero AggregateTransition creation conditions
  bidirectional, (4) require Thread import receipt sequence order using exact decimal-string
  comparison, and (5) bind historical provider-reconciliation cursor to its Thread. It
  separately confirms that hello response/readiness, supervisor authority, canonical Thread
  persistence/replay, and Windows durable acceptance are not safely implementable from
  these local schema/protocol changes.
- The P4 audit returned without edits: safe schema invariant is `vcsKind: none` => no
  `commitId`; the independent Indexd coverage gap is a test that each generation pin affects
  identity and that absent/present workspace pins differ. No source-completeness or
  authorized acquisition behavior is safe without WorkspaceService/Guard/ArtifactService;
  MemoryService ownership and policy also remain absent.
- Implemented the P4 no-VCS revision invariant in commit `e71bb5c8947cf0647616d19d260a00cf70294a7`
  (`fix(schema): enforce no-vcs revision commit invariant`). `RevisionRefV1` now rejects
  `vcsKind: none` with `commitId`, retaining optional Git commit IDs. Independent review
  `ses_edfa5b88fffeEOx4VQUvc2si1p` approved spec compliance and task quality without findings.
  Fresh task evidence: focused Schema test, typecheck and Prettier pass; full Schema suite
  remains 39 pass / 2 known event-manifest inventory/order failures. Commit is local only,
  not pushed. It adds the previously untracked `repo-intelligence-v1.ts` and test in full,
  not only the new invariant; this task did not stage or alter other dirty files.
- Expanded `indexd/src/lib.rs::pins_are_part_of_the_generation_digest` so every independent
  generation pin changes local generation identity while snapshot content stays fixed,
  including `workspace: None` vs `Some(...)`. Commit `496871325ba99cb4e2c52adf49ed657b40c99252`
  (`test(indexd): cover all generation digest pins`) is local only. Fresh Indexd verification:
  `cargo test --offline` (24 tests), `cargo fmt --check`, and warning-free Clippy pass.
  Independent review `ses_edfa22214fferIsMx6sqzVNOkx` found no code/spec defect; it recorded a
  minor commit-scope concern because the already-dirty Indexd source commit also captured the
   previously implemented P4 pagination/cursor changes. Those changes were documented and
   verified in prior handoff entries; no history rewrite or rollback was done. This remains
   implementation-identity coverage only, not canonical digest or source-authority evidence.
- P2 logical Schema checks were added in commit `73fe92aa8eae3454870c90bd05225004613b403a`
  (`fix(schema): tighten P2 import invariants`): `schemaVersion` is bounded to 0..65535;
  AggregateTransition creation (`ABSENT`/`"0"`) is bidirectional; legacy import receipts
  require strictly increasing Thread-stream sequence using exact UInt64Decimal comparison;
  and historical provider-reconciliation cursors bind to their enclosing Thread. Independent
  review `ses_edf9c858effeveG5XdLMq8lZUE` found no issues. Focused tests (10), typecheck and
   Prettier passed. Full Schema remains 43 pass / 2 known event-manifest inventory/order
   failures. This is payload validation only; no event-log or ThreadService behavior.
 - P2 pure hello policy now rejects absent trusted `expected_host_process_incarnation` in
  commit `be28edc45b22070a18aa330cbe93cd3b19a250d2` (`fix(kernel): require expected process
  incarnation for hello`). Independent review `ses_edf98767cffeLzsmZYg68x2joQ` found no
  correctness issues; it deferred a minor commit-scope note because the file was already
  dirty with reviewed P2 protocol checks. Kernel tests (34), fmt, warning-free Clippy,
  Windows-target test compilation and Clippy passed. No native Windows tests ran. This
  still does not authenticate the OS peer or define a hello response/readiness protocol.
- P1 preflight coverage already present in the dirty `packages/core/test/composition-manifest.test.ts`
  was verified and committed as `71db5d92328f533c2022d33abc181afc427a3935`
  (`test(core): cover composition preflight diagnostics`). It covers ServiceOffer metadata
  mismatch/unknown definition, both requirement list-mode mismatches, selected contribution
  and binding policy cap-plus-one rejection before decoding, and empty explicit global
  bindings. Independent review `ses_edf5df7eaffendlybFt526jfZ0` found no issues. Focused Core
  tests (29), typecheck, and Prettier pass. Full Core suite completed 1,137 pass / 5 failures
  outside the changed test file: three `flock` timeout cases (the file passes 10/10 in
  isolation), one Config migration test exceeding its 5-second timeout even in the isolated
  file run, and Vercel provider import initialization (`ReferenceError: Cannot access
  'VercelPlugin' before initialization` at `packages/core/src/plugin/provider.ts:66`). No
   unrelated fixes were attempted. Commit is local only; no push.
- The P1 source/schema prerequisites used by those tests are now committed in
  `9319a8c09f85f95e35c18c67b509e2e6002f6a5d` (`feat(horizon): add bounded composition
  preflight`): Core selected-contribution/global-binding preflight, P1 resolver regressions,
  shared ActorRef/RetryClass schemas, lock activation-order permutation validation, and
  hook-mode matrix tests. Core 41 focused tests + typecheck/Prettier and Schema 20 focused
  tests + typecheck/Prettier pass. Independent review `ses_edf571de6ffeOjs96QZ1MQJ217` found
  no material P1 behavior issue, but raised a medium concern that `ActorRefV1.id` is a raw
  string. No code change was made: `arch_V1/12-DOMAIN-SCHEMAS.md:79` defines the actor ID as
  `string` without max length or token grammar, while `arch_V1/13-COMPOSITION-IPC.md:439-447`
  bounds encoded frame/body/event payloads and Rust `validate_value_bound` enforces aggregate
  byte caps (`kernel/src/protocol.rs:496-513`). Replacing it with `Identifier` would invent
  a max/pattern and reject previously representable IDs; only add an individual schema
  constraint if an approved contract defines it. The review's separate activationOrdinal
  observation remains owner/resolver validation unless the spec says otherwise. This commit
  does not implement CompositionService lifecycle, artifact digest authority, or P1
  acceptance.
- P2 Kernel peer/cancellation work is committed in `79f3e65b18a7efba131a50a7ff7892043a07cd48`
  (`feat(kernel): tighten peer checks and request cancellation`). Kernel 34 offline tests,
  fmt, warning-free Clippy, Windows-target test compilation and Clippy passed. Review
  `ses_edf532806ffeCTipWFsFjxRkE0` found no material defect, but noted the report initially
  overdescribed Windows-gated path tests as portable; the report and this handoff now clarify
  they were only cross-compiled, not run on Linux. This adds an advisory cancellation
  registry and tightens path spelling, but still does not establish supervisor integration,
  canonical Thread/event-log ownership, or native Windows acceptance.
- A read-only architecture memo (`ses_edfb08aa6ffeSae9ouG0hvXXXJ`) found the documented
  `.agents/skills/architecture/SKILL.md` absent. It recommends continuing only pure
  contracts/search prototypes until required owners exist. Non-binding options were
  recorded for event-log recovery vs an explicitly approved versioned migration, a typed
  hello acknowledgement vs a typed `RpcResponseV1` handshake result, and byte-exact vs
  versioned domain-separated digest preimages. None is adopted; only the decision owner may
  authorize a normative contract change. Completion still requires event-log recovery or
  approved migration, handshake/readiness authority, artifact/digest owner, P4 authorized
  source and canonical services, plus native Windows evidence where required.

### Next Exact Steps

1. Verify and commit the remaining dirty P2 Kernel Windows-peer/request-cancellation and P4
   Memory-schema/Indexd documentation slices as distinct coherent changes. Inspect full diffs
   first; preserve existing edits and avoid mixing P1/P2/P4 ownership. The safe gaps found in
   the latest contract audits are now covered; do not invent owners or contracts. P1
   bytes/lifecycle, P2 event-log/handshake/Windows acceptance, and P4 authorized source
   acquisition/MemoryService remain blocked. Latest full Schema suite: 43 pass / 2 known
   ignored-substrate failures; latest full Core suite: 1,137 pass / 5 unrelated failures.
2. On a supported Windows/MSVC host, run `cargo test --offline` in `kernel/` so Windows peer
   tests execute against real pipe/DACL/token APIs. Linux `cargo check --tests` and Clippy are
   compile/lint evidence only; local test linking failed because `link.exe` is absent. Do not
   claim Windows platform acceptance from Linux cross-checks. Handshake integration still
   requires `13.3's negotiation-response/authority contract; never treat `StartupGate`
   reports as authentication proof.
 3. Preserve P1 decoded hook preflight/lock consistency as non-authoritative. Do not add
    byte/digest validation until canonical artifact bytes, a versioned
    CapabilityRequestV1 digest preimage, and ArtifactService are specified/available; do
    not hash in Core or reuse indexd.
4. Keep P1 lifecycle/owner integration and P2 Thread owner/persistence blocked until the
   mandated `horizoncode-eventlog` source/physical contract is recovered and verified or
   architecture explicitly authorizes a migration.
5. Keep P4 process/source acquisition and MemoryService runtime blocked behind authenticated
   IPC, Guard/WorkspaceService authorization, ArtifactService bytes, and the canonical
   event-log owner. Continue pure snapshot-fed index/overlay and schema-contract work while
   bounded and contract-aligned; never treat opaque pins as authenticated evidence.
6. Continue P0.4/source provenance separately; the inventory still maps only 2,949 of
   6,629 paths, and the base/archive/license/baseline gates remain incomplete. Preserve
   the bootstrap allowlist; do not stage ignored baseline source, nested checkouts, or
   `.freebuff/`. `main` is now five commits ahead of `origin/main`; no push was performed
   during this continuation. Push only if explicitly required by the active user request.

- The configured `.agents/skills/rust-systems/SKILL.md` and
  `.agents/skills/testing-verification/SKILL.md` were not present at their documented paths;
  this Rust test increment followed `arch_V1/13-COMPOSITION-IPC.md` and adjacent kernel
  source/tests instead. `.agents/skills/typescript-tauri/SKILL.md` was also absent while
  adding the focused TypeScript resolver test; nearby code/tests and normative architecture
  were used.

### Decisions & Gotchas

- `arch_V1/` is the only normative architecture. Existing OpenCode code/instructions
  describe the substrate; they do not supersede Horizon contracts.
- Do not add a schema equality/uniqueness rule between
  `MemoryCandidateV1.proposedSupersedes` and `supersessionSources[].memoryId`: `12.12 lists
  these arrays separately but does not define their relationship. The accepted
  `MemoryRecordV1.supersedesMemoryIds` set is explicitly sorted/unique and remains distinct
  from candidate proposal data; candidate-set validation stays with MemoryService until
  its contract says more.
- Do not restore old root `crates/` or `ARCH/` to active `main`. Prior Git metadata and
  local archive refs were purged; do not claim that legacy source is locally preserved.
  The ignored nested paths remain untouched unless the user changes scope.
- The exact OpenCode commit is the base, not an acceptance claim. User-facing readiness
  remains gated by runtime and platform evidence.
- `kernel/src/startup.rs` is a pure sequencing helper, not a supervisor or security
  boundary. Its milestone methods trust the owning subsystem's report; no method performs
  OS peer authentication, event-log validation, durable epoch acquisition or reconciliation.
  A correct OS peer check must authenticate the exact channel and bind its process/token
  identity; `KernelHelloV1` nonce validation is only an additional handshake binding.
- The user explicitly chose to remove all six old Git metadata roots, initialize a new
  repository, and make the architecture-only first commit/push. The new `main` is pushed
  to `origin/main`; future commits should contain actual implementations as the user
  directed. The local OpenCode code tree remains ignored at the root.

## Task 6 continuation — 2026-10-09

### Active Goal

Task 6 is complete as a bounded memory Schema/architecture increment. The broader P1/P2/P4
continuation remains incomplete; no phase acceptance is claimed.

### Where We Stopped

- Commits on local `main`: `692a22e` (`fix(schema): enforce memory supersession ordering`)
  and `79ea9a8` (`fix(schema): enforce safe memory result ranks`). The first commit adds the
  previously untracked `packages/schema/src/memory-v1.ts` and its test, plus updates
  `arch_V1/09-SOURCE-MAP.md`, `10-DELIVERY.md`, `12-DOMAIN-SCHEMAS.md`, and
  `17-GOVERNANCE-DECISIONS.md`. The follow-up applies the `12.1 non-negative safe-integer
  rule to MemoryQueryResult ranks and adds boundary/ownership tests.
- Supersession arrays validate strict ascending UTF-8 byte order with `TextEncoder`; the
  comparator does not sort or normalize. Tests accept ordinary and Unicode-sorted values,
  including U+E000 before U+10000, reject both reverse orders and duplicates, and cover
  empty/singleton arrays. Candidate proposals remain independent of source observations.
- Test-first evidence: ordering test failed against the documented duplicate-only baseline
  when `['memory.z', 'memory.a']` decoded instead of rejecting; it passed after the bytewise
  comparator. The review-discovered rank test failed first on `rank: -1`; it passes using
  `NonNegativeInt`. Independent review `ses_edf1a0da1ffeKEjkzSJdZvxYnm` identified the rank
  issue, which was fixed in `79ea9a8`; a minor ambiguity around lone UTF-16 surrogates is
  deferred because no canonical malformed-string encoding/ID grammar is approved.
- Latest Schema evidence from `packages/schema/`: memory tests 7/63; direct five-file V1
  suite 33/252; `bun run typecheck`; targeted Prettier; all pass. Full `bun test`: 46 pass,
  2 known failures in unchanged `event-manifest.test.ts` (expected 55 server definitions,
  local ignored OpenCode inventory 58, plus associated event order mismatch). No upstream
  files were changed.
- Pre-existing P4 housekeeping was reviewed independently by `ses_edf106c3fffe3XeerGE2fTu4Fm`
  and committed separately: `5f6d1bd` documents bounded Indexd cursor/digest behavior;
  `31364ae` adds only narrow allowlist exceptions. Indexd checks pass: 24 offline tests,
  fmt, and warning-free Clippy. Ignore probes confirmed arbitrary new Schema/Core/Kernel
  paths remain ignored. Reviewer deferred a minor wording suggestion that cursor checksums
  detect accidental corruption only; existing README already says cursors are unauthenticated.
- `HEAD=31364aeb6002496d47c475ef2c9074e996750a44`, `main` is 11 commits ahead of
  `origin/main`; no push performed. Worktree is clean; `git diff --check` passes.
- Detailed evidence is in `.superpowers/sdd/horizon-p1-p2-p4/task-6-report.md` and the Task 6
  section of its progress ledger.

### Next Exact Steps

1. On a supported Windows/MSVC host, execute `cargo test --offline` in `kernel/` for native
   named-pipe tests. Linux cross-compilation is not runtime acceptance.
2. Continue P1 owner lifecycle/artifact/digest, P2 event-log/Thread/handshake/native Windows,
   and P4 authorized source/canonical owner gates only when their listed external sources,
   contracts, owners and platform evidence are supplied or approved; the local dependency
   audits found no safe implementation increment that avoids inventing those decisions.
3. Continue P0 archive/source provenance, OpenCode base/inventory, baseline and license gates
   when authorized source acquisition and evidence are available. Preserve the bootstrap
   allowlist and do not stage ignored baseline source or nested checkouts.

### Decisions & Gotchas

- `MemoryQueryResultV1.matches[].rank` follows the domain-wide `12.1 default: a non-negative
  safe integer. No fractional score semantics are inferred. If rank is intended to be a
  fraction, that requires an explicit architecture exception.
- `TextEncoder` replaces lone unpaired UTF-16 surrogates with U+FFFD. Do not add an ID
  grammar or alternate escaping comparator without an explicit canonical encoding decision.
- MemoryService remains responsible for exact accepted-set derivation, authorization,
  source revalidation, and atomic candidate/record append. The Schema change proves none of
  those behaviors and does not close P4 acceptance.


---
## 2026-10-10 — OpenCode-first architecture consolidation (documentation, not implementation)

- Audited all 20 existing `arch_V1/*.md` files programmatically line-by-line and mapped 6,684 tracked paths plus actual Rust kernel/module seams. Compared eight critical OpenCode root/snapshot files byte-for-byte; no mismatch found in those eight.
- Preserved user-provided v2 consolidated architecture in `docs/architecture-input/universal-software-agent-v2-source.md`, and incorporated its 09–13 design chapters in `arch_V1/19`–`23`. This provenance is non-normative.
- Added topic-specific v2 amendments across old architecture 01–18, GLOSSARY and README; added 24–26 repo-specific mapping, data/API crosswalk, UI/commands and test journeys.
- Added *design-only* `arch_V1/contracts-v2/` schema/OpenAPI/SQL; SQL checked in-memory, no user DB migration.
- New owner target: OpenCode Session/messages/providers retained, Rust managed Goal/Run/effect/evidence/lease ownership. Previous Rust canonical Thread service is superseded at design level, **not migrated in code**.
- Retained all existing OpenCode and kernel source intact; no Git rebase/reset/deletion or worktree cleanup.
- **Next gates:** OpenCode V1/V2 Session persistence parity spike; Rust Session correlation bridge; effect broker tool-routing enforcement; provider/free-local harness probe; worktree pool sandbox + cleanup tests; novice/expert UI acceptance; independent verification.
- Architecture writing or passing a schema parse does **not** satisfy those implementation gates.

- **Validation on WSL (2026-10-10):** existing kernel `cargo test --manifest-path kernel/Cargo.toml --locked --offline --quiet`: 70 + 11 + 25 = **106 tests passed**; documentation: 28 Markdown files, 80 local relative links, 140 fence markers, no QA failures; SQLite in-memory integrity OK and 15 additive `hc_` tables; `git diff --check` clean. These are code-primitive and architecture-artifact checks, **not** full integrated functionality.
 
## 2026-10-10 — P1.1 Session projection (focused tested)

- Added `kernel/src/session_projection.rs`, `kernel/src/bin/session_sync_probe.rs`, `kernel/tests/session_projection.rs`; exposed module in `kernel/src/lib.rs`, updated `.gitignore` source allowlist.
- Consumes the real OpenCode EventV2 `event` column model as a READ-ONLY SQLite input. Kernel SQL stores correlation metadata/cursor, not transcript or raw prompt. Strict event order, source-boundary digest, idempotent replay, restart-state persistence, immutable run/attempt link.
- Rust formatting passed; full kernel test suite: **115 passed** (70 unit + 11 owner-log golden + 25 owner-log recovery + 9 Session projection).
- Process-level synthetic event SQLite file through `cargo run --bin session_sync_probe`: first import 3, re-run 0, cursor 2, source SHA unchanged.
- **Not implemented:** live OpenCode host ↔ Rust RPC, actual session admission under provider turn, managed scheduler, tool/effect permission broker, final goal verification. Those remain gates.
- **Next:** test connection against a real disposable OpenCode Session SQLite fixture or headless host; add authenticated supervisor transport and ReadOnly Session event follower, then guarded ToolIntent routing.

## 2026-10-10 — P1.2-A live OpenCode EventV2 follower

- Improved `kernel/src/session_projection.rs` with consistent SQLite snapshot isolation across source hash and event reads.
- Extended `kernel/src/bin/session_sync_probe.rs` with bounded or continuous read-only WAL follow mode, source query-only settings, safe batch sizing and source/destination alias checks.
- Added `packages/core/test/kernel-projection-live.test.ts` and Git allowlist tracking to prove real OpenCode `EventV2.Service` publisher -> Rust WAL follower in a disposable SQLite DB. No external APIs or private user sessions used.
- Evidence: Rust **115/115 tests passed**; Bun integration **2/2 tests passed** with 18 assertions; `packages/core bun run typecheck` passed; no database migration or provider changes.
- **Not complete:** automatic authenticated Rust supervision, IPC event subscription, real PromptAdmitted / Prompted admission and tool broker. These are next and must not be falsely treated as done.

## 2026-10-10 — Agent execution guidance and tracked handoff refresh

- Scanned existing 28 `arch_V1` Markdown files: 9,087 lines before new audit chapter. Added `arch_V1/27-IMPLEMENTATION-READINESS-AUDIT.md` with source-to-coverage matrix, contradictions, evidence boundaries and next steps.
- Rewrote root `AGENTS.md` to remove stale branch/snapshot/canonical-Thread guidance; added continuous verified-slice loop, subagent ownership, actual skills/MCP discovery, worktree lease/cleanup, budget and safety boundaries.
- Created tracked `HANDOFF.md` (P1.2-B objective, exact current files, statuses, commands, tests, follow-on implementation sequence), plus `IMPLEMENTER_PROMPT.md` for direct coding-agent use.
- Corrected obsolete canonical conversation row in `arch_V1/17-GOVERNANCE-DECISIONS.md`; updated root/arch index and delivery/adoption handoff pointers. No application runtime implementation added by this handoff pass.
- Existing Git dirty state preserved; no push/commit/cleanup of user code performed. Next: P1.2-B actual admitted prompt parity, authenticated Rust supervisor, bounded streaming/ACK/replay and cancellation; then effect broker.

## 2026-10-10 — P1.2-B incremental Session and IPC primitives

### Implementation

- Extended `packages/core/test/kernel-projection-live.test.ts` to use a file-backed,
  disposable OpenCode DB and the actual `SessionV2.prompt({ resume: false })`,
  `SessionInput.promoteSteers`, `EventV2`, and `SessionProjector` path. Rust reads the real
  versioned `PromptAdmitted` and `Prompted` events in order, preserves their OpenCode
  message ID, omits prompt text from its receipts, and imports zero duplicate rows after
  restarting the projection process. No provider is invoked.
- Added Linux `kernel/src/unix_peer.rs` authenticated Unix stream/listener. It validates
  canonical absolute socket parent, owner-only directory, socket ownership/mode, Linux
  `SO_PEERCRED`, UID/PID and exact `/proc/<pid>/exe` identity. It will not replace existing
  paths; listener cleanup is inode-bound.
- Added `kernel/src/rpc_handshake.rs` for the first hello on an authenticated Linux stream.
  It binds negotiated protocol/features to the nonce and process incarnation, sends a
  bounded typed rejection for incompatibility, and refuses application/control messages
  before Hello.
- Added `kernel/src/supervisor_session.rs` to connect that authenticated handshake to
  `StartupGate`, emit STARTING/READY/FAILED statuses, and gate application message reads
  and writes until READY. The connection object does not validate canonical state or
  reconcile recovery itself; a future process supervisor must only report those milestones
  after the required owners complete them.
- Added `kernel/src/subscription.rs` `BoundedSubscription` with a 1–256 queued/in-flight
  cap, owner and strict sequence checks, exact event drift handling, backpressure without
  cursor movement, sent-only contiguous ACK release and idempotent repeated latest ACK.
- Hardened source projection sequence advancement against signed integer overflow and
  exposed its correlation tuple as a named type. Simplified `session_sync_probe` option
  parsing to satisfy strict Clippy. Added narrow `.gitignore` exceptions for the new files.
- Updated `arch_V1/13-COMPOSITION-IPC.md`, `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md`,
  `27-IMPLEMENTATION-READINESS-AUDIT.md`, and `HANDOFF.md` with exact implementation
  boundaries and the next gate.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `cargo fmt --manifest-path kernel/Cargo.toml --check` | pass | Rust formatting |
| `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline` | pass, 130 tests (after startup-session addition, re-run below) | Full kernel workspace including peer auth, hello negotiation, READY gating, bounded ACK window and Session projection; no Windows runtime |
| `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings` | pass | Strict lint; repaired two pre-existing warnings in projection/probe code |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bin session_sync_probe` | pass | Rebuilt follower binary |
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, 3 tests / 26 assertions | Actual Core admission/promotion event persistence, Rust projection and restart replay; no model/provider turn |
| `bun run typecheck` from `packages/core` | pass | Core TypeScript compatibility |
| `git diff --check` | pass | Whitespace check |

### Exact files and remaining gates

- Added `kernel/src/{unix_peer,rpc_handshake,supervisor_session,subscription}.rs` and
  `kernel/tests/{unix_peer,unix_hello,startup_session,subscription_window}.rs`; changed
  `kernel/{Cargo.toml,Cargo.lock,src/lib.rs,src/protocol.rs,src/session_projection.rs,src/bin/session_sync_probe.rs}`;
  extended `packages/core/test/kernel-projection-live.test.ts`; narrow allowlist and docs
  listed above. The tree already contained many user-authored uncommitted architecture and
  implementation files; none were reverted, staged, or committed.
- Not done: process start/ownership, `StartupGate` handshake/readiness integration,
  application RPC dispatch, OpenCode EventV2 source pagination over RPC, typed
  `RESNAPSHOT_REQUIRED` response, ACK reconnect persistence, host shutdown/cancel/restart,
  Session turn completion/interruption/compaction parity, Windows native runtime proof.
  Do not describe P1.2-B as complete.
- Next task: implement a real supervisor that reports canonical state validation, owner
  epoch, recovery and service readiness only after those owners complete each operation;
  connect `BoundedSubscription` to a bounded OpenCode source page/RPC writer and the
  existing OpenCode lifecycle. Then finish shutdown/cancel/restart and compaction parity.
  Once complete P1.2-B acceptance is proven, proceed to P1.3 universal ToolIntent
  permission/effect mediation.

## 2026-10-10 — P1.2-B bounded authenticated RPC page delivery

### Implementation

- Added `AuthenticatedKernelSession.send_subscription_page` in
  `kernel/src/supervisor_session.rs`. After READY, it reads an exact-cursor redacted page
  from `SessionProjection`, offers it through `BoundedSubscription` (maximum 256 queued +
  in-flight records), writes metadata-only `RpcMessageV1::Event` frames and waits for
  matching subscription ACKs. It returns the last acknowledged cursor, delivery count and
  `has_more`; it does not poll OpenCode or own process lifecycle.
- ACK validation uses the existing protocol and window logic: only delivered exact cursors
  advance, other subscription IDs are rejected, non-ACK controls fail closed, and duplicate
  ACK frames have a per-page bound. Projection resnapshot/drift errors remain typed local
  failures and are not yet encoded as a subscription wire error.
- Added `kernel/tests/session_rpc_delivery.rs` for a real authenticated Linux Unix socket,
  negotiated Hello, READY milestones, Subscribe, redacted OpenCode-shaped EventV2 rows,
  event delivery and ACK cursor return. A negative test proves an ACK from another
  subscription is rejected. Added a narrow ignore allowlist entry for this test.
- Updated `arch_V1/13-COMPOSITION-IPC.md`,
  `arch_V1/24-LOCAL-CODE-AUDIT-AND-MIGRATION.md`,
  `arch_V1/27-IMPLEMENTATION-READINESS-AUDIT.md`, and `HANDOFF.md` to state the new
  one-page boundary and retain the open live-supervisor gates.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `cargo fmt --manifest-path kernel/Cargo.toml --check` | pass | Formatting of the Rust workspace |
| `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline` | pass, **134 tests** | Authenticated page/ACK path and all kernel regressions; no supervised process lifecycle or Windows runtime |
| `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings` | pass | Strict warning-free Rust lint |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bin session_sync_probe` | pass | Existing follower binary still builds |
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, 3 tests / 26 assertions | Actual OpenCode prompt admission/promotion events and replay parity; no provider/model turn |
| `bun run typecheck` from `packages/core` | pass | Core TypeScript typecheck |
| `git diff --check` | pass | Whitespace validation |

### Files and remaining gates

- Changed `kernel/src/{lib,supervisor_session}.rs`, added `kernel/tests/session_rpc_delivery.rs`,
  added its narrow `.gitignore` allowlist, and updated the four documentation/ledger files
  named above. Existing dirty user architecture and implementation work remains untouched;
  no changes were staged or committed.
- P1.2-B remains incomplete: actual managed child start/stop, source refresh and sustained
  subscription loop, typed wire-level `RESNAPSHOT_REQUIRED`, cancellation/interruption,
  owner epoch authority, crash recovery and compaction/turn parity have not been verified.
- **Next exact task:** add a runnable Linux Rust Session supervisor endpoint that owns the
  authenticated listener and read-only OpenCode/projection connections, reports startup
  milestones only after source validation and projection recovery, and dispatches bounded
  Subscribe/ACK pages. Prove it as a child process with corruption, peer-auth and restart
  tests. Then add the Core Effect host lifecycle using existing process/session services;
  keep prompt bodies out of Rust and logs. Afterwards add repeated projection refresh/page
  delivery with persisted resume cursor and typed resnapshot mapping.

## 2026-10-10 — P1.2-B durable supervisor lease and epoch binding

### Implementation

- Added Linux `kernel/src/supervisor_lease.rs` `SupervisorLease::acquire`. It accepts only
  an existing canonical owner-private directory with no unprotected shared-writable
  ancestor, opens a no-follow private lock file,
  takes a nonblocking process-held `flock`, validates a bounded canonical epoch value, and
  increments it using a synced temporary file, atomic rename and directory sync. Lease drop
  releases the lock; a restart claims the next epoch. Corrupt epoch data, overflow, symlinked
  files, public directory permissions and a competing process fail closed without overwriting
  the unsafe state.
- `AuthenticatedKernelSession<'lease>::owner_epoch_acquired` now takes a
  `&'lease SupervisorLease` and retains that borrow for the session lifetime. This prevents
  the RPC connection from reaching READY with an arbitrary number or outliving the process
  lock that owns its epoch. `StartupGate` remains a sequencing helper and does not validate
  OpenCode source integrity or reconcile managed effects.
- Added `kernel/tests/supervisor_lease.rs`; updated startup and RPC socket tests to acquire
  and retain actual leases. Tests cover shared-writable ancestors and symlinked epoch
  state. Added narrow `.gitignore` exceptions. Updated
  `kernel/src/lib.rs`, `arch_V1/13`, `24`, `27`, and `HANDOFF.md` with the lease boundary,
  evidence and next executable-supervisor task.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `cargo fmt --manifest-path kernel/Cargo.toml --check` | pass | Rust formatting |
| `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline` | pass, **139 tests** | Lease restart/exclusion/failure, authenticated page delivery and all kernel regressions; no runnable supervisor process |
| `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings` | pass | Strict warning-free lint |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bin session_sync_probe` | pass | Existing follower binary |
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, 3 tests / 26 assertions | Actual OpenCode prompt admission/promotion and projection restart replay |
| `bun run typecheck` from `packages/core` | pass | Core TypeScript typecheck |

### Remaining gates and exact next task

- The durable lease is a Linux primitive, not yet a process supervisor. The running
  executable still does not own the listener, OpenCode read-only DB, projection, startup
  validation/recovery or request dispatch. P1.2-B also still lacks continuous polling,
  typed wire resnapshot, persisted reconnect cursor, shutdown/cancellation/interruption,
  provider-turn and compaction parity, and native Windows runtime validation.
- **Next:** implement a Linux Session supervisor executable that acquires this lease,
  authenticates the existing Core host identity, validates/replays the read-only OpenCode
  source before READY, and dispatches bounded Subscribe/ACK pages. Prove process start,
  source corruption, peer mismatch, graceful stop and restart fencing before adding the Core
  Effect child lifecycle wrapper. No prompt content enters Rust or logs.

## 2026-10-10 — P1.2-B runnable one-connection Session observer

### Implementation

- Added `kernel/src/bin/session_supervisor.rs`, a Linux process entry point around the
  existing peer authentication, hello negotiation, `SupervisorLease`, Session projection,
  startup gate, bounded subscription and ACK writer. It requires explicit absolute source,
  state, socket, host executable, configured Session, nonce and process-incarnation args.
- Before binding a socket, the process acquires its private monotonic lease, opens the
  OpenCode database read-only with `query_only`, checks SQLite integrity and the EventV2
  columns, opens a separate private projection, checks projection integrity, and fully
  synchronizes the configured Session. It refuses a projection symlink or hardlink alias
  to the canonical DB. After exact OS peer auth and hello binding, it reports READY,
  accepts only a cursor-bearing Subscribe for that configured Session, sends one redacted
  page capped at 64 events, waits for ACKs, and exits to release its lease.
- Added `kernel/tests/session_supervisor_process.rs` with actual child-process tests for
  valid auth/hello/READY and event+ACK, prompt redaction, source-byte immutability, restart
  replay and epoch increment, corrupt SQLite and unsupported EventV2 schema rejection
  before listener creation, same-file hardlink rejection, malformed cross-owner cursor
  rejection, configured-Session scope enforcement and invalid argument rejection.
- Updated `.gitignore`, `kernel/src/lib.rs`,
  `arch_V1/13-COMPOSITION-IPC.md`, `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md`,
  `27-IMPLEMENTATION-READINESS-AUDIT.md`, and `HANDOFF.md`. Added the execution plan at
  `docs/superpowers/plans/2026-10-10-session-observer-supervisor.md`.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `cargo test --manifest-path kernel/Cargo.toml --locked --offline --test session_supervisor_process` | pass, 7 process tests | Real compiled process, auth, startup, bounded page/ACK, corruption/alias/scope failure and restart; page completion currently closes the connection |
| `cargo fmt --manifest-path kernel/Cargo.toml --check` | pass | Rust formatting |
| `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline` | pass, **146 tests** | Full kernel workspace, including process integration |
| `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings` | pass | Strict Rust lint |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bin session_sync_probe` | pass | Existing diagnostic follower remains buildable |
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, 3 tests / 26 assertions | Actual OpenCode admission/promotion persistence and projection restart replay |
| `bun run typecheck` from `packages/core` | pass | Core TypeScript typecheck |
| `git diff --check` | pass | Whitespace check |

### Remaining gates and next task

- This is a bounded one-connection observer, not full P1.2-B. It exits after one page, so
  there is no wire-level page-complete/`has_more` signal, repeated live subscription,
  persistent ACK cursor, Core-managed startup/shutdown/cancellation, interruption bridge,
  provider-turn or compaction parity, or native Windows runtime proof. Error paths before
  READY fail process startup; post-READY protocol errors close the connection.
- **Next:** keep the endpoint alive for multiple cursor-bearing Subscribe pages and define
  a negotiated typed page-end/resnapshot control so the client knows whether to continue.
  Then add the Core Effect child lifecycle using existing process/session abstractions and
  verify stop/restart/cancellation against this executable.

## 2026-10-10 — P1.2-B negotiated repeated Session subscriptions

### Implementation

- `kernel/src/protocol.rs`: added typed `PageEnd` and `ResnapshotRequired` controls and
  MessagePack encoding/decoding/validation. Resnapshot cursors must share an owner.
  `session.events.page-control.v1` gates both server-to-client controls.
- `kernel/src/supervisor_session.rs`: stores negotiated feature capabilities, emits
  `page_end` only after the bounded page is fully ACKed, and emits a resnapshot control only
  when that feature was negotiated. Empty pages report the exact requested cursor.
- `kernel/src/bin/session_supervisor.rs`: loops on one authenticated connection for repeated
  cursor-bearing Subscribe controls with a stable subscription identity; it refreshes from
  the OpenCode read-only source before every page, exits on matching Unsubscribe, and returns
  `resnapshot_required` then closes if history is missing.
- `kernel/tests/session_supervisor_process.rs` and `session_rpc_delivery.rs`: cover multiple
  pages over one child process, refreshed EventV2 rows, exact page-end cursors, no-duplicate
  restart resume, matching Unsubscribe, and the no-partial-page typed retention-gap path.
  Under the full parallel suite, the old 3-second socket readiness wait flaked; increased
  the bounded wait to 15 seconds after confirming the child was only delayed during parallel
  startup. The focused process test and full suite then passed.
- Updated `arch_V1/13-COMPOSITION-IPC.md`, `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md`,
  `27-IMPLEMENTATION-READINESS-AUDIT.md`, and `HANDOFF.md` with the wire and lifecycle
  contract. No source DB or canonical conversation semantics changed.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline` | pass, **148 tests** | Includes protocol controls, ACK-bound page delivery, repeated child polls, source refresh, restart resume, retention loss and all prior regressions |
| `cargo fmt --manifest-path kernel/Cargo.toml --check` | pass | Rust formatting |
| `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings` | pass | Strict warning-free lint |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bins` | pass | Both Rust binaries |
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, 3 tests / 26 assertions | Actual OpenCode prompt admission/promotion, WAL following, replay and no-alias checks |
| `bun run typecheck` from `packages/core` | pass | Core TypeScript typecheck |
| `git diff --check` | pending final diff review | Run after documentation/handoff updates |

### Remaining gates and exact next task

- This endpoint is still server-only from the application's perspective: no Core Unix
  client speaks the Rust MessagePack protocol, no Effect-scoped process owns the binary, and
  there is no durable host-side ACK cursor. Native Windows transport remains unverified.
- **Next:** inspect `packages/opencode/src/util/process.ts`, Effect layer conventions and
  architecture IPC feature binding; implement a Core-side typed MessagePack hello/readiness
  client and scoped supervisor child starter with bounded startup, cancellation, and cleanup.
  Then prove end-to-end local process launch, authentication, negotiated READY, repeated page
  receipt/ACK, graceful Unsubscribe, startup failure and crash/restart epoch advancement.
- Full P1.2-B also still requires actual turn completion/interruption/compaction parity and
  native Windows acceptance; P1.3 universal ToolIntent mediation remains blocked by that gate.

## 2026-10-10 — P1.2-B Core host connection and Effect child scope

### Implementation

- `packages/core/src/session/supervisor.ts` adds `SessionSupervisor.Service.open` and
  `SessionSupervisorClient`. The service starts the Rust binary through Core's existing
  `AppProcess`/`ChildProcessSpawner`, uses argument-array spawning with child stdio ignored,
  verifies absolute/canonical paths and owner-only state/socket permissions, and waits up to
  the bounded startup deadline for Hello negotiation plus READY. Each launch chooses a
  nonce-derived socket filename, avoiding collisions with crash-left socket paths.
- The MessagePack host codec uses pinned direct `msgpackr@2.0.2` (`packages/core/package.json`)
  and length-prefixed frames with an 8 MiB frame ceiling, 16 MiB queued-byte ceiling and
  128-message queue cap. It validates result nonce/incarnation/features and startup statuses.
  `subscribe`, `receive`, `ack`, `unsubscribe` enforce configured Session scope, exact next
  event sequence, 64-event window, oldest-first ACK, page-end cursor parity, and owner-bound
  resnapshot controls. No event payload or prompt content is written to child stdout/stderr.
- `SessionSupervisor.node` is registered in `packages/opencode/src/effect/app-runtime.ts`.
  The API is caller-scoped and ready for Session lifecycle use; this slice does not yet attach
  it automatically to every SessionV2 request or persist a host ACK cursor.
- `kernel/src/bin/session_supervisor.rs` treats an idle post-READY channel EOF as clean stop.
  `packages/core/test/kernel-projection-live.test.ts` launches the actual compiled Rust
  observer from Bun against actual OpenCode file-backed `SessionV2.prompt` and
  `SessionInput.promoteSteers` events. It proves Hello/READY, `PromptAdmitted` then `Prompted`,
  redaction, rejection of a forged out-of-order ACK, exact ACKs, page end, Unsubscribe, Effect
  scope interruption, socket cleanup, lease release, epoch advancement and safe replay after
  restart. Existing OpenCode provider and SessionStore implementation remains canonical.
- Updated the `.gitignore` source allowlist only for the new Core client, Core manifest, test,
  and AppLayer registration; updated `arch_V1/13`, `24`, `27`, and `HANDOFF.md`. The Bun add
  postinstall script was reviewed after it ran; it only sets executable bits on node-pty helper
  files under node_modules. No source caches or user-owned processes were removed.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, **5 tests / 43 assertions** | Actual OpenCode events cross a real Bun → Rust process/channel; redaction, auth/negotiation, ACK order, Unsubscribe and Effect interruption/restart |
| `bun run typecheck` from `packages/core` | pass | Core TypeScript typecheck, including `SessionSupervisor.node` and AppLayer registration |
| `cargo test --manifest-path kernel/Cargo.toml --workspace --locked --offline` | pass, **148 tests** | Full kernel regression after idle EOF stop behavior |
| `cargo fmt --manifest-path kernel/Cargo.toml --check` | pass | Rust formatting |
| `cargo clippy --manifest-path kernel/Cargo.toml --all-targets --locked --offline -- -D warnings` | pass | Strict Rust lint |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bins` | pass | Rust binaries used by the Bun integration |
| `git diff --check` | pending final doc/diff review | Run after final handoff edits |

### Remaining gates and exact next task

- The Core API is currently opened by a caller; SessionV2/API prompt lifecycle does not
  automatically start or consume it. Core does not persist the acknowledged cursor across
  process restart. Rust projection replay remains idempotent, but host-side resume starts from
  a caller-supplied cursor.
- **Next:** wire `SessionSupervisor` to the existing OpenCode Session/event lifecycle with
  explicit configuration and per-Session ownership; persist the last ACK cursor in Rust
  projection metadata (or an architecture-approved control-plane projection), then prove
  automatic startup, continuous client-driven page refresh, stop, restart and resume from the
  stored cursor. Inspect actual `SessionV2` and server call paths before selecting the seam.
- Then finish provider-turn, interruption and compaction parity plus native Windows transport
  acceptance. P1.3 universal ToolIntent mediation remains downstream of full P1.2-B.

## 2026-10-10 19:24 UTC — P1.2-B completed-page cursor recovery

### Change

- `packages/core/src/session/supervisor.ts`: `SessionSupervisorClient.resumeCursor()` reads a
  private per-session checkpoint; `subscribe()` resumes from it by default and rejects an
  explicit cursor rollback. After receiving and validating Rust's `page_end` (which follows
  contiguous ACK handling), the client atomically writes only `{ownerKind, ownerId, seq,
  eventDigest}` with owner-only file mode and directory/file sync. It rejects malformed,
  cross-session and symlinked checkpoint files. The path stays within the validated private
  supervisor state directory and uses a validated Session ID.
- `packages/core/test/kernel-projection-live.test.ts`: added actual child restart after a
  completed page, no-duplicate resume, a mid-page interruption after an event ACK that proves
-  the old checkpoint is retained and replay is safe, explicit cursor rollback rejection,
  symlink refusal and malformed checkpoint rejection. Current focused result: **5 tests / 52
  assertions passed**.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts` now registers
  `SessionSupervisor.node` in the active HTTP API root graph. `.gitignore` narrowly allows
  that source path and the existing HTTP route test path. This composes the service but does
  not start observers or create an event consumer.
- `arch_V1/13-COMPOSITION-IPC.md`, `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md`,
  `27-IMPLEMENTATION-READINESS-AUDIT.md`, and `HANDOFF.md` now identify the cursor as a
  rebuildable host control-plane projection, not transcript state.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| Initial `bun test ./test/kernel-projection-live.test.ts` before implementation | expected red: `client.resumeCursor is not a function` | Test failed specifically on the missing checkpoint API |
| `bun test ./test/kernel-projection-live.test.ts` after implementation | pass, **5 tests / 52 assertions** | Actual Bun → Rust startup; EventV2 prompt parity; completed-page restart resume; interrupted page replay; rollback and symlink/malformed checkpoint rejection; shutdown/epoch recovery |
| `bun run typecheck` from `packages/core` | pass | Core source/test TypeScript compile; completed after >60 seconds |
| `bun run typecheck` from `packages/opencode` | pass | HTTP server root imports and composes the Core supervisor node |
| `bun test --timeout 30000 ./test/server/httpapi-cors.test.ts` from `packages/opencode` | pass, **3 tests / 10 assertions** | Active HTTP route layer boots with supervisor registration; CORS behavior remains intact |
| `bun test` from `packages/core` | **1146 pass, 1 fail** | 1147 tests / 3182 assertions across 148 files; unrelated `util.flock > refuses token mismatch release and recovers from stale` timed out at 5 seconds during the full parallel run, after process-contention tests took 18 seconds |
| `bun test ./test/util/flock.test.ts` from `packages/core` | pass, **10 tests / 26 assertions** | Rerun the only full-suite failure in isolation; it passed in 572 ms |
| `git diff --check` | pass | Clean whitespace/conflict-marker check after architecture and handoff updates |

### Remaining gates

- Automatic SessionV2 lifecycle startup/stop and a real managed-control-plane consumer remain
  unwired. Determine explicit Rust binary configuration and the server's actual lifecycle owner
  before attaching this observer; do not start per-session children whose events are discarded.
- Full P1.2-B still requires provider-turn, compaction, move and interruption parity, plus native
  Windows transport acceptance. P1.3 universal ToolIntent mediation remains downstream.
- **Next:** inspect the live `SessionV2` and server route composition with explicit runtime
  config; implement only when the lifecycle can deliver events to a real consumer and guarantee
  scope stop/recovery. Note that the broad Core suite had one contention-related timeout; its
  exact failing test passed when rerun alone.

## 2026-10-10 20:55 UTC — P1.2-B recorded provider-turn projection parity

### Change

- `packages/core/test/session-runner-recorded.test.ts`: after a real `SessionV2.prompt` and
  `SessionExecution.resume` through the pinned recorded OpenAI Chat cassette, selects the exact
  six EventV2 rows from the runtime database and writes those rows unchanged into a disposable
  SQLite source with the OpenCode EventV2 table shape. Runs `session_sync_probe` twice against
  that source and checks that Rust keeps versioned prompt admission/promotion, step start, text
  start/end and assistant settlement in order, preserves message IDs, stores no prompt or answer
  text, and creates no replay duplicates. This test makes no live provider call.
- `.gitignore` now narrowly allows that existing recorded test. `arch_V1/24`, `25`, `27` and
  `HANDOFF.md` record the additional acceptance evidence and keep compaction/interruption gates
  open.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `bun test ./test/session-runner-recorded.test.ts` from `packages/core` | pass, **1 test / 15 assertions** | Actual recorded SessionV2 runner turn; exact six persisted EventV2 rows; Rust projection ordering, ID correlation, redaction and replay idempotency |
| `bun run typecheck` from `packages/core` | pass | Includes the new projection integration test |
| `cargo build --manifest-path kernel/Cargo.toml --locked --offline --bins` | pass | Rebuilt both pinned kernel binaries after the workspace had no `target/debug` artifacts |
| `bun test ./test/kernel-projection-live.test.ts` from `packages/core` | pass, **5 tests / 52 assertions** | Re-run after binary rebuild; supervisor/checkpoint/auth/recovery integration |
| `git diff --check` | pass | Final whitespace/conflict-marker check after documentation updates |

### Remaining gates and next task

- Actual SessionV2 HTTP/lifecycle ownership is still not wired. The OpenCode HTTP root composes
  both the V2 server Session API (`packages/server/src/handlers/session.ts`) and the compatibility
  Instance Session API. V2 uses Core `SessionV2`/`SessionExecutionLocal`; the supervisor service
  is available but automatic starts still need a real managed control-plane consumer. Do not
  create idle per-session children without a consumer.
- Full P1.2-B still needs compaction parity, move/interruption recovery during an active turn,
  automatic lifecycle startup/shutdown/recovery and native Windows IPC acceptance. After the
  architecture dependency gate is met, proceed to P1.3 universal ToolIntent mediation.
- **Next:** trace the Session V2 API and production route convergence contract, settle the explicit
  binary/state configuration seam from architecture, and implement per-Session observer ownership
  only where the event consumer can use its output. Keep the broad Core suite's one contention
  timeout visible (the sole failed test passed in isolation).

## 2026-10-10 20:59 UTC — P1.2-B compaction and interruption projection parity

### Change and source review

- `packages/core/test/session-runner.test.ts` now copies exact committed EventV2 rows from
  Core's real automatic completed-summary compaction and blocked-provider interruption into
  disposable EventV2-shaped SQLite sources and invokes the Rust projection.
- The compaction assertion checks two `Started`/`Ended` pairs, message correlation and omission
  of summary/recent-turn content from receipts. The interruption assertion checks exact source
  ordering, redaction, and no fabricated `step.started` when cancellation precedes commit.
- Source tracing found the HTTP root composes two public Session APIs: the V2 `/server` group
  in `packages/server/src/handlers/session.ts`, plus the compatibility Instance handlers in
  `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`. V2 is wired to
  `SessionV2.node`/`SessionExecutionLocal.node`; neither route has a production supervisor-event
  consumer, so automatic child launch would currently discard the projection events.
- Updated `arch_V1/13`, `24`, `25`, `27`, `HANDOFF.md` and this log. No Session persistence,
  Rust projection schema, provider selection or tool execution behavior changed.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `bun test --timeout 30000 ./test/session-runner.test.ts --test-name-pattern 'interrupts a blocked provider turn without local tool execution'` from `packages/core` | pass, **1 test / 8 assertions** | Actual Core interruption EventV2 sequence matches Rust projection; cancellation precedes durable `step.started` |
| `bun test --timeout 30000 ./test/session-runner.test.ts --test-name-pattern 'automatically compacts into a completed summary and retained recent turn'` from `packages/core` | pass, **1 test / 22 assertions** | Actual Core compaction EventV2 rows preserve pair ordering/IDs and redact compacted text |
| `bun run typecheck` from `packages/core` | pass | Updated tests and Core code typecheck |
| `git diff --check` | pass | No whitespace errors or conflict markers across the full dirty worktree |

### Remaining gates and next task

- Parity is proven for these persisted histories; active-turn process-crash recovery is not.
- Automatic lifecycle is blocked on approved V2 route convergence and an actual managed
  control-plane event consumer, plus explicit validated Rust binary/state configuration.
  Native Windows and move parity also remain open.
- **Next:** read the governing route/consumer contracts in `17`, `20`, `23`, `25`, identify
  the approved convergence seam and implement a real per-Session consumer there. Then verify
  startup, cancellation, stop, crash/restart and cursor resumption before P1.3.

## 2026-10-10 21:10 UTC — complete provider-batch staging before local dispatch

### Requirement and implementation

- Requirement: architecture §§11–14 and 17 require a complete, validated provider ToolBatch
  before any effect dispatch. Previously `SessionRunnerLLM` called `ToolRegistry.settle`
  immediately on each streaming `tool-call` event, so a later provider error could arrive
  after sibling effects had already started.
- `packages/core/src/session/runner/llm.ts`: buffers local `ToolCall` events until both
  provider `finish` and `step-finish`; no dispatch on error, interruption, missing terminal
  or missing step settlement. Preflights every call in the same request-pinned tool
  materialization. If any local schema fails, valid siblings receive a bounded rejection
  result and no call dispatches. A valid batch retains concurrent execution and waits for
  settlement before continuation.
- `packages/core/src/tool/tool.ts`: adds `Tool.validate`, using the registered input schema
  and `LLM.ToolFailure` mapping. `packages/core/src/tool/registry.ts` adds
  `Materialization.validate`, resolving only against registrations pinned at materialize
  time; unknown calls fail batch validation. No Session/EventV2 SQL schema or public API
  changed. No prompt/message content was added to Rust state.
- `packages/core/test/session-runner.test.ts`: changed eager-dispatch coverage to require
  no effects while the provider is still streaming; added provider failure, missing finish,
  missing step-finish, and invalid-sibling failure injection; updated interrupted/partial
  call expectations so no persisted call remains spuriously running.
- `arch_V1/06`, `14`, `17`, `20`, `23`, `24`, `27`, `HANDOFF.md` updated. `.gitignore`
  narrowly permits the new `packages/core/src/session/runner/llm.ts` and tool source files.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| Initial red test: `bun test --timeout 30000 ./test/session-runner.test.ts --test-name-pattern 'holds local tools until the provider turn completes|does not execute a local tool when its provider response fails after the call'` | expected red before implementation | Proved local calls executed during a still-open provider stream and after a later provider failure |
| `bun test --timeout 15000 ./test/session-runner.test.ts --test-name-pattern 'holds local tools until the provider turn completes|does not execute a local tool when its provider response fails after the call|does not execute or continue an incomplete provider tool response|requires a completed provider step before executing the collected tool batch|rejects the full local tool batch before executing when any call fails schema validation|does not execute an uncompleted local tool batch when provider streaming fails'` | pass, **6 tests / 25 assertions** | Delayed dispatch, provider failure, incomplete terminal/step, schema-invalid sibling zero-dispatch |
| `bun test --timeout 30000 ./test/session-runner.test.ts` from `packages/core` | pass, **91 tests / 296 assertions** | Full SessionRunner regression, compaction/interruption, valid concurrent tools, existing failure paths |
| `bun test ./test/session-runner-recorded.test.ts` from `packages/core` | pass, **1 test / 15 assertions** | Recorded selected-provider turn still preserves EventV2 and Rust projection parity |
| `bun run typecheck` from `packages/core` | pass | Core runner/tool registry/test types |
| `git diff --check` | pass | Clean whitespace/conflict-marker check after documentation edits |

### Security effects, limitations and next task

- This removes early local dispatch before the complete provider response and rejects the
  whole local batch on an invalid input. It does **not** make the runner a universal broker:
  it still executes effects in Bun, uses no Rust Guard/resource/budget decision, lacks
  Rust-owned ToolBatch transitions and ordered acknowledgements, and does not cover
  compatibility/MCP/plugin/hosted paths. Do not claim production permission enforcement.
- P1.2-B observer automatic ownership is still gated on a real managed consumer; native
  Windows, move parity and active-turn restart recovery remain open. The HTTP root exposes both
  V2 server Session handlers and compatibility Instance Session handlers.
- **Next:** read `arch_V1/12`, `13`, `14`, `17`, `25` and inspect OwnerLog/RPC source; define
  and test the first Rust `ToolIntent` admission/decision seam without storing a second
  conversation transcript. Connect Core only after full Guard and Rust execution coverage.

## 2026-10-10 21:15 UTC — cross-path effect routing audit and regression verification

### Source-path findings

- `arch_V1/24` now records the actual dispatch paths found in Core V2 and the compatibility
  Session: V2 `SessionRunnerLLM` → request-pinned Core `ToolRegistry` → `Tool.make.execute`;
  compatibility `SessionPrompt.runLoop` → `SessionTools.resolve` → AI SDK callbacks →
  `SessionProcessor`; plus direct `SessionPrompt.shellImpl` and provider-executed tools.
- Core V2's whole-response barrier is not applied to the compatibility Instance Session route.
  Both V2 server Session and compatibility Instance Session routes are composed; the explicit
  compatibility shell API also bypasses model-tool registry callbacks. Existing local permission
  checks are not Rust Guard/EffectIntent/lease/ExecutionHost receipts. Provider-executed effects
  cannot be mediated after the call event.
- No code or runtime route was changed in this audit. Production route convergence remains
  closed until a Session-linked Rust owner admits a whole ToolBatch and every effectful path is
  mediated or unavailable under governed operation.

### Verification ledger

| Command | Result | Covered behavior / gap |
|---|---|---|
| `cargo fmt --manifest-path kernel/Cargo.toml --check && cargo test --manifest-path kernel/Cargo.toml --locked --offline --quiet` | pass, **148 tests** | Current full kernel package tests: 71 unit + 11 OwnerLog golden + 25 recovery + 9 projection + remaining supervisor/subscription/transport integrations. Expected failure-injection diagnostics were printed by passing tests. |
| `bun run typecheck && bun test --timeout 30000 ./test/session-runner.test.ts && bun test ./test/session-runner-recorded.test.ts` from `packages/core` | pass: typecheck; **91 tests / 296 assertions**; **1 test / 15 assertions** | Core runner, recorded provider parity fixture, compaction/interruption paths, and staged whole-response local batch behavior. |
| `git diff --check` | pass | Full dirty worktree has no whitespace/conflict-marker errors. |

### Exact next task and outstanding gates

- P1.2-B remains open: a real Session/control-plane consumer must own the supervisor stream;
  V2 server and compatibility Instance Session APIs are both composed, and neither currently
  consumes supervisor events. Native Windows IPC and recovery during an active provider turn
  remain unverified. Do not auto-start children whose events no managed owner consumes.
- First broker implementation unit: add the Rust managed Thread/SessionLink owner adapter
  that consumes redacted projection correlations and admits a complete, pinned ToolBatch on
  the Thread owner stream. Derive principal/scope from authenticated host context; do not copy
  OpenCode messages. Then layer Guard, PREPARED EffectIntent, one-use lease, ExecutionHost and
  reconciliation before connecting any effect path. Current OwnerLog/protocol primitives do
  not yet implement these domain transitions.
- The Core barrier remains staging-only. Compatibility built-ins, MCP/plugin callbacks,
  direct shell, hosted tools, Guard coverage, policy modes and OS confinement still need
  mediation or an explicit governed-mode unavailable result.

### Route-trace correction and composition checks — 2026-10-10 21:20 UTC

- A deeper trace of `packages/opencode/src/server/routes/instance/httpapi/server.ts` found
  that both `serverRoutes` (the package server's V2 Session API) and `instanceRoutes` (the
  compatibility Session API) are composed in the same HTTP root. The earlier summary that
  only the compatibility Session API was public was inaccurate and has been corrected in
  `arch_V1/24`, `arch_V1/27` and `HANDOFF.md`.
- The V2 `/server/session.prompt` handler uses `SessionV2.Service` and the Core V2 runner. The
  compatibility Instance handlers use `SessionPrompt.Service`. `SessionSupervisor.node` is in
  the root graph, but neither path consumes supervisor events as Rust-managed Thread/control-
  plane facts. This is the precise lifecycle-consumer gap.

| Command | Result | Covered behavior / gap |
|---|---|---|
| `bun run typecheck` from `packages/server` | pass | V2 Session handler and composed service typecheck |
| `bun run typecheck` from `packages/opencode` | pass | OpenCode HTTP route composition and compatibility handlers typecheck |
| `bun test --timeout 30000 ./test/server/httpapi-cors.test.ts` from `packages/opencode` | pass, **3 tests / 10 assertions** | HTTP root boots both route groups with supervisor service available; does not prove lifecycle consumer or Guard mediation |
| `git diff --check` | pass | After corrected route audit and handoff updates |

The next implementation task is a Rust managed Thread/SessionLink owner adapter that can
consume authenticated, redacted Session correlations and commit their links without copying
conversation messages. It must establish the consumer needed by P1.2 lifecycle, then admit
whole pinned ToolBatches on the same Thread owner stream. Existing OwnerLog/RPC primitives do
not yet implement this domain state machine. The active effect bypass inventory remains in
`arch_V1/24`; no compatibility route or effect execution changed in this source audit.

### Competitive architecture gap audit completion — 2026-10-11 11:06 IST

Scope completed:
- current normative architecture, operational handoff/instructions, docs/spec plans, repo-local
  skills/agent definitions and the `indexd` implementation README were reconciled by authority;
- public Codex/OpenCode/Cline/Grok Build source/docs and Claude Code public/low-confidence
  reconstruction patterns were compared without treating competitor behavior as Horizon proof;
- §§28–34 plus affected owner chapters were amended rather than creating a second architecture.

Second-pass contracts added/strengthened:
- `LanguageServiceBroker` coexistence with editor-owned Pyright/rust-analyzer/tsserver/etc.;
- execution-time Plan/read-only mutation enforcement through shell/script/LSP/MCP aliases;
- fail-closed malformed/truncated structured tool calls and compatibility-stream assembly;
- local endpoint connect/health vs cold-load/response-start/TTFT timing;
- safe checkpoint restore after later commits/branch/dirty/untracked human work;
- immutable structured `PlanHandoffV1`;
- context epoch markers and reviewed named memory blocks;
- bounded terminal/artifact text search;
- managed retry exhaustion → BLOCKED/FAILED rather than identical token-burning retry;
- runtime critical-path stage budgets and incremental/frozen-prefix rendering;
- isolated expensive renderers, Mermaid first;
- explicit `builtin.system-operator` and `builtin.browser-qa` specialist profiles;
- clean-room task families inspired by SWE-bench, Terminal/TUA, OSWorld, WebArena/VisualWebArena
  and tau-style policy/tool benchmarks.

Machine-readable additions:
- `arch_V1/contracts-v2/agent-profile-v2.schema.json`;
- `arch_V1/contracts-v2/plan-handoff-v1.schema.json`;
- `arch_V1/contracts-v2/context-ledger-v2.schema.json`;
- `arch_V1/contracts-v2/runtime-observation-v1.schema.json`.

Repo-local implementation helper and operational-doc reconciliation:
- `.opencode/skills/horizon-docs/SKILL.md`, narrowly allowlisted in `.gitignore`;
- `AGENTS.md` now directs coding agents to use it for targeted architecture retrieval and its stale 115-test baseline was corrected to the newer verification evidence;
- `IMPLEMENTER_PROMPT.md` now reads §§28–34/`horizon-docs` and starts from the current ManagedControl/SessionLink + ToolBatchControl/effect seam;
- root `README.md` no longer preserves stale P2-branch/merge or proposed-ownership wording;
- `CONTEXT.md`, `STATS.md`, `SECURITY.md`, and `CONTRIBUTING.md` were read line-by-line and bannered as retained OpenCode implementation/reference, historical metrics, upstream security policy, and upstream contributing guidance respectively. In particular, upstream `SECURITY.md`'s `No Sandbox` statement cannot override Horizon §05/§14/§21.

Implementation truth correction:
- `indexd/src/README.md` proves only a bounded in-memory lexical PARTIAL slice. Persistent
  symbol/reference storage, watcher/supervisor lifecycle and LSP orchestration remain
  DESIGNED/unverified and must not be reported complete.

Validation evidence:
- final architecture recount: **36 `arch_V1` Markdown files / 14,647 physical lines**;
- `docs/`: **5 Markdown files / 3,278 physical lines**;
- Markdown fenced-code QA across architecture/docs/root operational + `horizon-docs`:
  **46 files, 0 unbalanced fences**;
- JSON parsing passed for all four new schemas plus existing
  `managed-event.schema.json` and `control-api.openapi.json`;
- all four new schema files and the `horizon-docs` manifest were confirmed to exist at the
  documented paths;
- targeted new-reference checks passed by direct file inspection.

Validation limitations:
- the broad relative-link checker was stopped because UNC `Test-Path` resolution stalled;
  new references introduced by this audit were checked directly instead;
- both WSL-side and Windows-Git-over-UNC `git diff --check` / `git status` attempts stalled at
  the WSL/UNC bridge in this session. **Do not record Git diff/status as passed for this audit.**
  No reset/cleanup/commit/push was attempted.

No production runtime behavior was changed by this architecture pass. The immediate code
dependency remains the Rust ManagedControl/SessionLink + ToolBatchControl → Guard →
PREPARED EffectIntent → one-use lease → ExecutionHost → reconciliation path, plus the existing
P1.2 lifecycle/platform gaps. New competitive-audit capabilities follow the dependency ordering
in `arch_V1/10-DELIVERY.md`; they do not preempt the current safety/control-plane convergence.

## 2026-10-11 — C0–C7 design/schema convergence

Six normative HLD/LLD sections reconciled to OpenCode conversation / Rust managed-effect split; legacy excerpts archived. Created arch_V1/36 and 37, machine-readable tool alias seed and 8 new JSON schemas, and architecture offline validation at scripts/architecture/validate_convergence.py. Offline run observed 411 checks / zero failures before this documentation synchronization. Re-run after editing docs; Git diff check and actual TS/Rust cross-language runtime fixtures remain pending. No runtime changes, no tool-broker P1.3 acceptance, no external provider calls or cleanup.

## Contract-convergence source-bound test evidence — 2026-10-11

Run python3 scripts/architecture/run_contract_tests.py for design-schema validation followed by the **existing, real** Bun Session-to-Rust projection and Rust authenticated RPC tests. Last manual source-bound tests on 2026-10-11: 5 Bun tests, 52 assertions, pass; 2 Rust tests, pass. Those tests do not validate the newly proposed Browser/LSP/Delegation/Automation/Mermaid/Cache services. Add generated TS/Rust binding validation, shared malformed/cross-process fixtures, security/timeout/replay tests before any new service is WIRED/VERIFIED.

Manual commands were Core Bun live-projection fixture and Rust session_rpc_delivery offline test; both passed without paid providers.
