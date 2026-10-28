# HorizonCode — Current implementation handoff

## 2026-10-28 12:20 UTC — push blocked by one pre-existing gate test (round 10)

Repaired `node_modules` offline (`bun install --frozen-lockfile --offline`: the `effect` workspace
symlink was broken and `node_modules/.bin/tsgo` missing). The push gate now passes every source
audit, the typecheck, `cargo build`, the Rust `managed_control`/`resource_budget` regressions, the
Core suites (`kernel-projection-live` 1 pass after the `wrk` fixture fix) and all OpenCode suites
through `session/tool-batch`.

It stops at the last step, `prompt.test.ts -t "V1 model write is admitted"`: no
`GuardApprovalRequested` is published because the kernel admits that direct-mode write through the
quiet `prepared` lease path — and the write *does* land in Rust with a real `effectID` and
`receiptDigest`. Forcing `approvalPolicy: "always"` makes the dialog appear and resolve, but the
next tool dispatch fails `effect_denied: "approval principal, owner epoch, or one-use state does
not match"`, so the interactive approval flow for model tool calls is not wired end to end.
Baseline (pre-session) copy of that test does not compile at all, CI and the final verifier never
run it: the gate step was already red before this work.

Nothing pushed: 24 commits are local, the tree is clean, and the pre-push hook was not bypassed.

## 2026-10-28 03:20 UTC — terminal containment VERIFIED (round 9)

Guarded PTY execution is enabled: `GUARDED_PTY_RUNTIME_READY=true`, and every terminal.v1 run/start
ingress now carries durable ExecutionHost containment (per-effect cgroup-v2 identity in the durable
PREPARE record, OS confinement from the probed bubblewrap+Landlock backend, observed-exit-only
settlement, unobserved exit left durably UNKNOWN).

`tool_batch_guard_matrix` **9/9** — including workspace write confinement with outside and
`.git/config` writes denied, and a confined command unable to reach a host TCP listener.
`host_terminal_process` 3/3, `host_terminal_events_process` 1/1, `tool_batch_multi_call` 8/8,
`managed_control` 39/39 + 57/57. Three real defects were found and fixed on the way (cgroup child
scan rejecting control files, terminal artifacts filed with `Unknown` redaction, and a
`Value::Signed(0)` receipt encoding every encoder rejects); `FinalizeRun`'s over-strict
per-Task-final-revision conjunct was removed so verified Tasks at their own heads aggregate into a
finalization, with the real stale-proof case kept as its own regression.

The Rust verifier now runs containment steps with the privilege a non-delegated cgroup needs
(`run_step_root`, separate `/tmp` target), and this session also pushed the P1–P9 work plus the
push-gate prerequisites (AGENTS.md governance pointers, fixture reference targets, scratch hygiene
in `.gitignore`).

Still open: the live free-model send (source-mode observer pin refuses before dispatch; the provider
gate fails closed by design) and the P8 evaluator's 3 skipped authentic-HostRun cases.

## 2026-10-27 21:10 UTC — guarded write VERIFIED end to end (round 7)

The offline guarded-write journey passes: `E2E_V1_SMOKE=PASS`, `write=completed`, file content `OK` (2 bytes), `cost=0`, `zero_egress=true`, unauthenticated probe 401 with no file created. Two fixes made it work: `executeWrite`/`executePatch` now reuse the ToolBatch's registered Location (the kernel refused a second, workspace-less Location as a lease binding mismatch), and the E2E parser now scans every assistant message for the write tool part.

Still open: the free-model turn is refused at registration because the allowlisted catalog entry has incomplete pricing (`cost {input:0, output:0, cache:{}}`) and the strict free proof rejects it; terminal containment (`tool_batch_guard_matrix` 3/9). Nothing staged; `.env` remains the only place the test key exists.

## 2026-10-27 21:05 UTC — symlink-safe revision (round 6)

Workspace revision now hashes symlink targets without following them and excludes dependency/build/cache trees, so a normal project with `node_modules` no longer fails closed; `workspace_revision` 7/7, `effect` 63/63. The E2E wrapper restores the served project cwd and the guarded-write journey runs in its own clean `work/` project.

The guarded write now reaches lease settlement and stops at `capability lease binding mismatch` (kernel `consume_lease`). Earlier blockers were cleared in order: owner conflict, symlink refusal, revision size cap, harness cwd. Free-model turn still refuses at registration because the allowlisted catalog entry has incomplete pricing (`cost {input:0, output:0, cache:{}}`) and the strict free proof rejects it. No provider call, no file write, nothing staged.

## 2026-10-27 20:55 UTC — workspace binding (round 5)

Added a local workspace (`local` adapter + deterministic `Session.create` binding) so direct Sessions carry a workspace: the offline E2E's `location_owner_conflict` is gone, sessions show `workspaceID=wrk_local_…`, adapter 3/3, focused regression 85/85, typecheck 0.

Two blockers surfaced, both fail-closed: (1) HostKernel's workspace revision refuses any symlink, and the E2E instance root is the repo (which has `node_modules` symlinks) — so projects with dependencies cannot run direct-session effects; (2) the free-model turn is refused with `ProviderModelNotFoundError` because the allowlisted catalog entry has `cost {input:0, output:0, cache:{}}`, so the strict free proof rejects it and the route is never registered. No provider call was made.

## 2026-10-27 21:40 UTC — full verifier PASS (round 8)

`V1-FINAL-VERIFY=PASS steps=31` (run `20261027-210730`): all typechecks, P1–P9 focused suites, P8 evaluator/RC0, P9 release readiness (158), verifier self-checks, and the real offline guarded-write journey (`E2E_V1_SMOKE=PASS`, `write=completed`, `content=OK`, `cost=0`, zero egress, 401 negative with no file).

Key fixes this stretch: `executeWrite`/`executePatch` reuse the ToolBatch's Location; direct-session Locations are bound to a directory-derived local workspace at registration (sessions keep their prior shape, so P7 routing is unchanged); symlink-safe workspace revision with dependency-tree exclusions; E2E project cwd and parser corrections.

Still open: terminal containment (`tool_batch_guard_matrix` 3/9) and the live free-model send (source-mode observer pin refuses before dispatch; provider gate fails closed by design).

## 2026-10-27 20:40 UTC — credential import verified (round 4)

The guarded credential path now works end to end. Two real defects were fixed: (1) the kernel's u64 `expiresAtUnixMs` arrives as `bigint` and both authorizers required `number` — `secret.v1/authorize_put` was therefore always `malformed`; (2) the Secret Service client negotiated the 1024-bit algorithm but used the 768-bit RFC 2409 group-1 prime, so every real service public key was rejected. Regressions added; focused auth 19/19, full `test/auth` 110/110, opencode typecheck exit 0.

Evidence: `horizoncode provider --provider openrouter` through a masked PTY with the repo-local HostKernel manifest reports "Credential stored for OpenRouter (openrouter) at version 1." The key exists only in that Secret Service entry plus the gitignored `.env` (0600); a leak scan found no other copy.

Still blocked: the free-model turn (`horizoncode run --model openrouter/nvidia/nemotron-3.5-super-vl:free`) and the offline guarded-write journey both stop before dispatch because the session is created with `workspaceID=undefined` (HostKernel `location_owner_conflict`). A default local-workspace bootstrap is the next prerequisite. Terminal containment (`tool_batch_guard_matrix` 3/9) is unchanged.

## 2026-10-27 19:57 UTC — verification digest (round 3)

Final verifier `20261027-194919`: **all steps PASS through 06b** (overlay audit; opencode/core/TUI typechecks; P1-P7 focused suites; P8 baseline/admission/RC0/evaluator; P9 release readiness 158 tests; verifier-grep regression; shell syntax) and the **only failure is step 07, the offline guarded-write E2E**.

Fixed this round and re-verified: P9 installer source-binding + migration identity validation; P8 evaluator accounting completeness (`accounting_incomplete`) and RC0 v3 `resourceLimits`; P6 provider/authorizer/ACP test contracts plus Bun on PATH for spawned subprocesses; P7 transcript test race; P3 RepoIntel actual-byte budget enforcement (no invalid-UTF-8 read bypass); Rust CodeMode inspect fixture correlation.

Blocking, fail-closed evidence: (1) terminal containment - `tool_batch_guard_matrix` 3/9, all terminal cases `capability_unavailable` until ExecutionHost PTY containment lands; (2) offline write journey - HostKernel `location_owner_conflict` because the session/Location has no workspace binding, so the guarded write never runs; (3) live OpenRouter `/provider` + free-model call not attempted (no key entered); (4) P8 authentic HostRun evidence still skipped (BLOCKED_P1/P2).

V1 remains **PARTIAL / NOT VERIFIED / NOT RELEASED**. Worktree stays dirty and unstaged; no stage/commit/reset/clean/publish, no paid call, no credential echo.

## 2026-10-27 — rapid implementation digest

Active: final implementation wave complete except P6 transport integration and final-runner refresh. User explicitly requested implement first, verify once at end. No tests/typechecks/Cargo run in this wave.
P1: Edit + Write exact effectID/target receipt checks now precede Attempt acceptance and ToolBatch settlement; regressions added, not run. Real Guard HostKernel negative still requires final batch.
P2: Core finalize rejects SUCCEEDED with non-SUCCEEDED phase; Rust CodeMode requestId binds to private Tool.Context callID. Regressions added, unrun. Rust aggregate Run/Task finalization invariants already exist; no extra edit.
P3: repo.tree fails closed for CURRENT/unknown freshness; RepoIntel checks aggregate actual bytes after read to prevent file-growth budget bypass. Tests added, unrun. ArtifactStore/anchor and authenticated query/cursor remain blocked.
P4: no additional safe edit; DAP/LSP/editor routes stay closed pending Guard/HostKernel/OS containment acceptance.
P5: WebSearch production request-envelope builder preserves exact admitted credentialRefsByRoute + challenge/location/attempt; CodeMode sparse array slots serialize/count as JSON null. Tests added, unrun; runtime gates closed.
P6 PARTIAL/BLOCKED at production seam: HostKernel `authorize_use`/`redeem_use` Rust tests passed 10/10; Core authorizer/local lease redemption exist in new edits, but ordinary OpenRouter still takes AI SDK raw fetch and bypasses Auth pinned `RequestExecutor`. Do not allow synthetic placeholder/raw credential there. Keep model route explicitly unavailable until native-runtime bridge can preserve SessionStore PINNED→DISPATCHING→UNKNOWN + ServerAuth owner. No provider call/key entered.
P7: TUI transcript near-tail sticky-follow synced to pinned OpenTUI one-row threshold with near/far/tail regression (unrun). No safe TUI `/provider` bridge: TUI worker HTTP/RPC cannot carry bytes, and there is no in-process trusted masked-input/Auth callback; keep slash/connect entry closed. CLI `provider` masked-TTY path remains separately available.
P8: reservation release requires exact bool terminal proof; RC0 budgets/charges reject bool/non-int/negative values. New tests unrun. RC0 NOT_ATTESTED; real workloads NOT RUN; OS quotas UNSUPPORTED.
P9: installer candidate `runtimeVersion` bound to binary manifest provenance and checked against CLI/upgrade --version; migration planner rejects missing/duplicate/colliding final IDs, permits self-target. Tests unrun; candidate build/install, CI and full identity acceptance remain.
P6 user key remains untouched. Free route is only OpenRouter `nvidia/nemotron-3.5-super-vl:free`; no paid/fallback requests. Signing/publish/release NOT performed.
Full P1–P9 E2E, full typecheck, final verification runner and release gates remain NOT VERIFIED. Preserve staged user files and dirty work; no reset/clean/stage/commit/push.
## 2026-10-26 — audit + integration wave (verified)

**Measured by SA-6 (repeatable E2E + status truth), same tree, no Git mutation.** HEAD `73e3876e7052cdb2f7d4dc95cd96177f0065ce1d` (`73e3876e7`) on `main`. Wave start: **186 dirty paths**; **188** at SA-6's measurement (146 modified, 40 untracked, 2 pre-staged `A` — `arch_V1/46-V1-RELEASE-EXECUTION-QUEUE.md` and `docs/superpowers/plans/2026-10-25-hostrun-contract.md`); concurrent owners later reached **193**, none of it SA-6's; the only path this wave adds is `scripts/e2e/v1-smoke.sh`; the deny-all overlay (`.gitignore:6` `*`) initially hid it from `git status`; the parent added exact `!/scripts/e2e/` and `!/scripts/e2e/v1-smoke.sh` exceptions on 2026-10-27, and `scripts/e2e/` is now visible as untracked. No `git add`, commit, push, reset, clean, rebase or worktree change was performed.

- **Typecheck:** NOT run in this wave (full typecheck is out of scope and the tsgo slot was held by concurrent owners). Last recorded parent result stands: `bun turbo typecheck` exit 2 with two `packages/session-ui/src/components/message-part.tsx` diagnostics; P7 repaired them and `packages/session-ui` typecheck exits 0. Full Turbo remains **UNVERIFIED**.
- **Kernel:** `kernel/target` is 3.1 GB; `hz-kernel` and `session_supervisor` binaries exist (2026-10-25 18:53). 9 `kernel/` paths are dirty. SA-6 ran no Cargo; kernel/Guard acceptance is **UNVERIFIED** in this wave (2 `cargo`/`rustc` processes from another owner were observed and left untouched).
- **E2E (new, repeatable):** `bash scripts/e2e/v1-smoke.sh` — repo-local HOME/XDG/TMPDIR under `.tmp/e2e/smoke`, random loopback port, Basic auth, trap-killed server, 401 negative probe, one `opencode/big-pickle` write turn asserting no `error`, exact `OK` file and cost 0. Latest run at this HEAD: **FAIL** — `E2E_V1_SMOKE=FAIL` / `EVIDENCE upto=assistant unauth=401 session=ses_e868bdf3cffeTyTeXcPhQA1tS6 assistant=done cost=0 write=none` / `EVIDENCE_FAIL step=assistant detail=assistant error present: {"name": "UnknownError", "data": {"message": "Session supervisor direct_provider_authority failed: direct provider pins require the authenticated Core AgentProfileV2 service"}}`. Server health, catalog, session create and the 401 probe passed; `.tmp/e2e/ok.txt` was not created.
- **Exact remaining E2E blocker:** the server-authenticated direct turn must wire the authenticated Core AgentProfileV2 service before provider dispatch (`Session supervisor direct_provider_authority failed`). Until then the V1 direct coding journey is **NOT VERIFIED**; V1 stays **PARTIAL / NOT VERIFIED / NOT RELEASED**.

**[SUPERSEDED 2026-10-26]** The two `bun turbo typecheck` / `message-part.tsx` diagnostics recorded in the older block below were repaired by P7 (`packages/session-ui` typecheck exit 0). The full Turbo result is still unverified. History is preserved below, with an explicit superseded marker on that block.

## Parent continuation — 2026-10-26 (strict checks and phase wave 2)

**Operator note (2026-10-26):** subagent dispatch failed twice — first `subscription_sharing_usage_limit_exceeded` despite the user's quota reset, then `Invalid model "inherit". Use "providerID/modelID" ...` when retrying with the AGENTS.md `inherit` convention. Recovery required enumerating the live model catalog and re-dispatching with `opencode-go/mimo-v2.6-flash`. This must become a HorizonCode self-inspection capability: on an invalid/unavailable model reference, inspect its own canonical model registry, return valid live slugs (or retry under the user's pinned model policy, `A-V2-03`), and surface quota errors with provider/reset context. Requirement recorded in `arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md` "Operator notes"; candidate for Task/dispatch acceptance rows in `32` — not implemented or tested.

V1 remains **PARTIAL / NOT VERIFIED / NOT RELEASED**. The first P1–P9 phase-owner wave returned partial results; P2's first dispatch and the P4 typecheck-repair dispatch failed with a transient `getaddrinfo EAI_AGAIN auth.openai.com`. After the user reported a quota reset, parent successfully launched nine fresh whole-phase continuations: P1–P9 (session ownership and exclusive scopes in `reports/phases/LEDGER.md`). P2 now owns P8's `worker_durable.rs` HostRun mirror integration; P8 is restricted away from that file. P4 owns the narrow prompt-test LSP environment fixture correction. P9 is checking only source-verifiable license metadata/notices and identity mapping; candidate work stays gated. No effect gate changed.

**[SUPERSEDED 2026-10-26 — see the verified integration-wave section above: the two message-part.tsx diagnostics were repaired; full Turbo is still unverified.]** Post-compaction continuation: P3/P5/P6/P7/P8/P9 were re-launched as whole-phase owners; P7 also has exclusive ownership of the current `packages/session-ui/src/components/message-part.tsx` Turbo typecheck repair. P1/P2/P4 continuations carry forward from the prior ledger and must be resumed if their sessions are no longer live. The latest `bun turbo typecheck` (after P4's prompt fixture fix) exited **2**, 7/30 tasks successful, with **two** current errors in `message-part.tsx`: unused `@ts-expect-error` at 1553 and absent `ToolState.metadata` at 1555. This supersedes the earlier one-error status. Parent made no product-source edit; full typecheck must rerun after P7's source-backed repair and concurrent phase edits settle.

P1 then fixed only the PTY test fixture path budget: a RED regression captured the composed path at 158 bytes; shortened repo-local roots now pass **1/1 (2 expectations)**. PTY session/ticket tests are **3 pass / 10 skipped / 0 fail (20 expectations)**; skipped start-dependent cases are not runtime acceptance. Core boundary suites **57/57 (564 expectations)**. Production socket validation/readiness flags remain unchanged; P1 still needs Cargo-authorized Rust acceptance plus integrated Guard/receipt/recovery, containment and observer evidence. P8's latest continuation remains partial with no changes: RC0 **150/150**, evaluator **71 pass / 3 skip**, trusted registry/setup absent, no authenticated 1/5/10/20 workload, K/L ingress blocked, and the Rust mirror crash-window test awaits P2's Cargo ownership. P8 has been resumed to inspect any remaining offline work; hard quotas and fan-out/pressure remain unavailable.

Latest phase handoffs: P1 added fresh offline protocol/ToolBatch/read-batch/launch evidence **48/48 (197 expectations)** plus guarded patch denial **10/10 (34)** and fail-closed patch boundary **1/1 (7)**. One combined discovery failure is P3-owned manifests-mode assertion; P1 did not touch it. P6 refreshed Auth/provider **876/876 (2,244)**, S1 **11/11 (69)**, Core Models.dev/settings/profile **57/57 (262)** and LLM executor **24/24 (99)**. P6 typecheck was interrupted twice and remains unverified. No readiness gates or downstream effects opened; exact P1/P6 blockers and owner reruns are in `reports/phases/LEDGER.md`.

P4 shortened its prompt fixture root and added socket-path budget assertions; the failure is fixture composition, but prompt suite was not rerun (could launch supervisor processes) and post-edit typecheck is unverified. P7 removed the stale TypeScript suppression and narrowed `ToolState`; `packages/session-ui` typecheck now exits 0. Its focused component suite has **14 pass / 1 fail** (`[omitted]` vs expected `undefined`), requiring owner diagnosis; full Turbo is pending. Exact P4/P7 tests and remaining whole-phase work are in the phase ledger.

P5 refreshed its offline search/CodeMode/registry suites (**163/628**), CodeMode package (**263/784**, typecheck exit 0), Core helper-pin fixture (**1/1**) and P7 consumer (**71/322**); adapter remains fail-closed and helper hidden pending P1/P2/P6/P7/P9. No gate or dependency advanced.

P7 continuation 59 traced its one failing component test to the existing sanitizer contract: the test calls `sanitizeToolDisplayValue` directly and expects `undefined`, while `PRIVATE_PAYLOAD_KEY` matching `output` yields the established `[omitted]` sentinel. It does not load the fixed `message-part.tsx`; no behavior or test was changed and historical origin is unknown. That focused test remains **0/1**, while `part-default-open.test.ts` is **5/5** and session-ui typecheck exit 0. Full Turbo and whole P7 acceptance remain pending; see `reports/phases/LEDGER.md`.

P7 continuation 60 added a fresh offline six-file TUI bundle pass (**155/1,398**) with no source changes. P4’s process-free OpenCode suite passed **129/455** (10 files), TUI editor/layout/settings **24/147**, external editor schema **11/24**, and TUI/Schema `tsgo --noEmit`; P4’s prompt suite was not run and post-fixture path budget remains unverified. OpenCode package typecheck has unrelated goal-review/managed-coordinator diagnostics; P4 tsconfig is blocked by missing Photon WASM. P4 remains blocked on P1/P2/P3/P8 and DAP/platform integration; exact work is in the phase ledger. No effect gates changed.

P3 fixed the P1-reported manifests assertion failure by correcting only its stale fixture coverage budget from 80 to the validator's existing 88-byte minimum. Narrow test **1/1**, focused Core **24/24**, OpenCode RepoIntel/repo-tools **92/92**, Schema RepoIntel **13/13**; no validator rule changed. P3 continues with navigation gated pending authenticated HostKernel and real-project acceptance.

P3 continuation 57 hardened the pure pressure planner test-first: malformed model limits now yield `unknown_context_limit`, invalid caller reserves are rejected; RED reproduced `NaN` selecting `auto_trim` and a negative reserve producing a negative pressure limit. Focused test **10/10 (36 expectations)**; convergence **1,298/0**. Navigation remains closed; authenticated HostKernel/cursor/recovery, trusted buffer, cache lifecycle, Guarded patch, real project, compile-policy wiring and approved parser provenance remain open. No effect/provider/Cargo/Git or dependent phase unblocked.

P1 continuation 67 added offline tests: managed-root Guard challenge **3/3 (15)**; approval cancellation/expiry **2 passed / 19 filtered**; changed launch suite **21/21 (56)**. No production change, Cargo, effects, provider/network, Git, or shared typecheck; both terminal gates remain false. Its P1 report’s known P3 manifests failure is stale: P3 fixed that fixture in continuation 56 (80→88-byte budget; regression 1/1). P1 Rust Guard/lease/receipt/UNKNOWN recovery, containment, observer, P2/P6/P7 integrations, HostRun, patch authority, and parent measurement remain open.

P5 and P8 have completed their latest re-audits as **PARTIAL** with no safe additional offline change; their unchanged tests were not repeated. P5 is waiting on P1/P2 guarded lifecycle/receipts, P6 SecretBroker consent, P7 caller/catalog and P9 exact helper packaging; search/CodeMode remain gated. P8 is waiting on P2 authenticated HostRun binding/receipt and real admission/Guarded evidence plus P1's installed terminal projection; trusted RC0, crash-window Cargo test and 1/5/10/20 workloads remain blocked, hard quotas unsupported. Both phase owners are queued only behind these explicit dependencies and must resume when they land; exact evidence is in `reports/phases/LEDGER.md`.

P2's latest audit exposed a concrete P2-owned gap: HostRun receipt route persists caller cursor without canonical P8 durable resolution; the evaluator tuple also lacks a trusted P8-frozen source. P2 was resumed to wire/negative-test durable cursor resolution while preserving invocation authority as blocked. P1's latest test-first fix rejects oversized and unknown-kind PTY protocol frames; protocol **8/8 (32)**, broader offline Core bundle **100/100 (735)**, fail-closed patch **1/1 (7)**. Legacy apply_patch-success tests remain intentionally unavailable; both terminal readiness gates false. Exact remaining P1/P2 work is recorded in the ledger.

Parent Wave-0 results: release readiness invocation from repo root with `PYTHONPATH=.` passed **116/116**; the strict typecheck wrapper now fails on `error TS` even when compiler exit is zero, captures only under repo-local `.tmp`, and cleans via trap (regression suite **2/2**, shell syntax passes). Its first full run found exactly one current OpenCode diagnostic at `test/session/prompt.test.ts:158`; Core and TUI were diagnostic-free. P4 owns the repair; turbo workspace typecheck is pending that repair and phase-owner TypeScript slot release. Overlay visibility is **0/0/0** after exact `.gitignore` exceptions. Convergence passes **1,298/0**. Markdown audit currently has 3 active missing-link blockers because tracked architecture pages target the untracked `arch_V1/46-V1-RELEASE-EXECUTION-QUEUE.md`; preserve the mixed tree and do not stage it just to alter this interim result.

Current release gate is **BLOCKED / 15**, with dirty source, no candidate or provenance digests, stale legacy artifact, 3 missing runtime license metadata rows, 46 missing direct legal notice rows, no install matrix, and Linux/WSL support not verified. MIT is the selected first-party license; exact artifact notices remain open. DEC-V1-12 signing/update is deferred and correctly unavailable. P1–P9 remain unverified. Current Git MCP snapshot: `main`, 20 commits ahead of `origin/main`, 104 modified / 20 untracked, none staged, no conflicts, one worktree; 825 GB free with existing `kernel/target` (2.5 GB) and `target-p2` (7.7 GB) retained. No Cargo slot, provider call, live Doctor, candidate build/install, signature, publication, commit or push is authorized/performed.

## Whole-phase continuation — 2026-10-26 (latest owner results)

V1 remains **PARTIAL / NOT VERIFIED / NOT RELEASED**. Phase owners resumed for P1–P9 with exclusive
scopes; P2 owns HostKernel/managed control and P8 owns the prospective durable OwnerLog mirror seam.
The current owner/dependency ledger is `reports/phases/LEDGER.md`. No readiness gate or effectful path
opened; no commit/push, provider call, candidate build/install, signing/publication, or LM-018 activity.

Newest offline evidence since the prior handoff:

- **P1:** process guard `collectStream` now has a 1,024-byte fallback cap; latest focused process-guard
  suite **12/12 (38 expectations)** after `pinCodeModeHelperRoot` rejected manifests over the existing
  4 KiB bound before reading/parsing (RED reproduced acceptance of an oversized valid manifest).
  Observer socket-path issue is partly diagnosed: paths >=108 bytes are rejected; a shortened fixture
  passed path checks but `openForSession` timed out before cursor/ACK/replay. No production workaround;
  observer lifecycle remains NOT VERIFIED.
- **P2:** scheduler fails closed if active and pending-verification Attempt IDs disagree (RED
  `Some("task-2")`, GREEN 1/1); HostRun decoder **4/4 (16 expectations)**. Managed recovery producer/TS
  DTO mismatch remains under P2 repair. After P8’s mirror tests passed 7/7, P2 is integrating the
  post-commit append, exact P8 cursor resolve and P2 receipt persistence; dispatch remains closed.
- **P3:** `repo_detect` Poetry false-positive, overlong/NUL excludes, root+nested `**/AGENTS.md`, and
  unsafe `displayPath` provenance labels are hardened. Imported and local instruction paths reject
  newline/control/bidi labels before expansion. `instruction-project.test.ts` **33 passed / 605
  expectations**; truncation budgets 1–512 bytes **512 expectations**. HostKernel navigation/recovery,
  trusted buffer ingress, cache, Guarded patch, real-project acceptance and parser provenance remain.
  RepoSearch additionally sanitizes source-controlled path/symbol/parser labels for terminal display
  while keeping canonical HostKernel read paths unchanged; bidi-path regression RED→GREEN,
  `repo-tools.test.ts` **33/143 expectations**.
  Latest resolver fixes reject all Unicode control/format/line/paragraph separators in instruction labels
  (U+061C RED→GREEN) and reject malformed, oversized or NUL exclude globs in the public helper;
  `instruction-project.test.ts` **34/609 expectations**.
- **P4:** standard LSP/DAP/REPL suite now passes without `--isolate`: **411 tests / 1,503 expectations
  across 24 files**. The adapter test mock delegates to the real closed protocol guard outside its two
  synthetic queue tests. Launch approval also rejects sparse target arrays and detaches/freezes nested
  HostKernel target data; launch-profile suite **30/30 (119 expectations)**, both regressions RED first.
  P1/P2/P3/P8 prerequisites, DAP namespace/ptrace and Linux/WSL acceptance remain; no process/editor/PTY
  launch occurred.
- **P5:** stale HostKernel route-plan digest returns UNKNOWN without aggregate receipt reference;
  NEEDS_APPROVAL rejects route attempts/provider/result/receipt evidence. Sparse in-memory catalog holes
  are tested; JSON frame arrays cannot encode holes. Search/CodeMode/registry suite **163 tests / 628
  expectations across 10 files**, all green. Integrated §32.28/CM-001–012 remain blocked; search and
  `codemode.execute` stay closed.
- **P6:** `SecureInputVault.issue` failure paths zeroize the owned credential copy; auth **71/270**,
  offline Doctor/direct-route/cost **30/131**, transport **8/24**. Models.dev now enforces its 16 MiB
  raw-response cap during streaming, excludes the over-limit chunk and cancels the response while
  retaining a decoded-size check; injected cancellation tests plus plugin tests **7/37**. Core typecheck
  still has three unrelated `workspaceID` fixture branding errors. Routes stay closed.
  Further offline fixes zeroize the caller buffer if expiry-clock initialization throws (auth **72/272**),
  cap Models.dev cache/override reads at 16 MiB + 1 byte (Models.dev/plugin **8/39**), treat inherited
  Doctor map keys such as `toString` as missing providers (Doctor/direct-route/cost **31/134**), and
  restore TTY mode if raw-mode setup throws (Auth **73/275**). Sidecar provenance reads now cap at
  **16 KiB + 1 byte**, ignoring oversized metadata; Models.dev/plugin **9/43**. Three unrelated
  `workspaceID` fixture branding diagnostics still block full Core typecheck; routes remain closed.
  Latest TTY fix also removes the credential listener and zeroes the temporary buffer if `stdin.resume()`
  throws after listener attachment; RED reproduced retained listener, full Auth suite **74/278**.
- **P7:** raster failure accessors, TOCTOU snapshot, and mismatched worker generation fail closed with
  inert fallback; accessor-backed token/cache/cost provenance/estimate fields and revoked Proxy records
  or `parts` arrays project as unavailable/UNKNOWN. Linux/Bun 1.4.2: renderer **39/39**, analytics
  **22/22**, six-file TUI bundle **154/154 / 1,396 expectations**. Integrated worker/artifact recovery, stream, analytics
  retention/export, guarded automation and rewind remain.
- **P8:** evaluator checks bind response `runId`, task, arm and group against frozen invocation (four
  negatives); evaluator **74 run / 71 pass / 3 skip**, RC0 **150/150**. Rust mirror append/resolve source
  is now present in `worker_durable.rs`: it validates P2 binding+durable receipt, appends to existing
  P8 OwnerLog, derives cursor from commit receipt, and reconstructs state through strict replay. Focused
  Cargo suite passed **7/7 (525 filtered)** using existing `target-p2`; P2 is assigned post-commit append →
  exact cursor resolve → P2 receipt wiring. P8 reviewed its test-only post-commit/pre-publication failpoint:
  it models panic/reopen, not process-kill/power-loss or P2 route authenticity; the new test remains
  uncompiled/unrun pending P2's Cargo-slot release. No dispatch unlock; RC0 NOT_ATTESTED, quotas UNSUPPORTED.
- **P1:** non-number `collectStream` caps now fail closed at zero and mark truncation; process guard
  **11/11 (37 expectations)**. Observer startup after socket-path shortening still times out before
  cursor/ACK/replay; stage is ambiguous, no production change.
- **P9:** offline NOTICE/path audit and package identity evidence remain, but release-readiness **110/110**
  is invalid under the no-Git constraint because synthetic fixtures invoke Git; do not rerun. Installer
  now rejects CR/LF and shell metacharacters before filesystem changes; POSIX/fish PATH formatting quotes
  validated paths and preserves spaces. RED across 7 subcases; focused pure tests **3/3** and `bash -n
  install` pass. No installer invocation or CLI spawn.
  Latest identity layer renames the Desktop workspace package to `@horizoncode/desktop` and updates
  matching root lock namespaces without dependency-payload changes; focused identity/importer parity
  tests **6/6** (no Git invocation). Existing Desktop author/homepage copy and upstream `@opencode-ai/*`
  dependencies are preserved; §56 maps remaining workspace IDs to coupled local consumers, so no
  isolated renames are safe. §57 offline tests: NOTICE/DEC-V1-12 **2/2**, packaging/identity **5/5**,
  workspace identity **6/6**, platform matrix **6/6** (corrected command **13/13**). No renderer/main-process
  code or localization strings changed; no safe isolated rename remains. Candidate remains NO-GO; no
  Git-dependent release audit, installer, CLI, build/install, Nix, signing or publication was run.

Open acceptance includes P1 Guard/lease/receipt/recovery and containment; P2 authenticated HostRun,
managed DAG/verifier/final settlement/restart; P3/P4 real authenticated journeys; P6 protected
credentials/live Doctor; P7 integrated streaming/automation; P8 trusted attestation, quotas and repeated
workloads; P9 exact artifact/legal closure and candidate qualification; and final integrated security,
recovery and release gates. Native Windows remains unavailable; LM-018 is NOT_RUN; candidate is NO-GO.
Mixed unstaged work and the single worktree are preserved.

## Whole-phase implementation update — 2026-10-26

The implementation wave has landed test-first offline fixes across P1/P3/P4/P5/P6/P7/P8/P9, plus
the parent-owned QA-007 `/api/event` authorization fix. Exact phase evidence is in
`reports/phases/P1.md`–`P9.md` and the owner/dependency ledger is in
`reports/phases/LEDGER.md`. Highlights include finite process-probe caps and argv-redacted diagnostics;
bounded/deduplicated instruction imports with external-approval path checks; detached/frozen LSP/DAP
worktree authority; immutable search admission and body-free UNKNOWN outcomes; broker-owned secret
zeroization plus bounded managed URL/header payloads; requestID-bound cost and stream-generation fencing;
RC0 u64 checks; and stricter NOTICE attribution. QA-007's actual `/api/event` stream filters question
events using persisted Session-owner ancestry. Latest focused results include P1 process guard
**10/10 (31 expectations)**, P3 resolver **26/26 (77)**, P4 focused LSP/process lifecycle **23/23 (29)**
and **23/23 (59)** but combined LSP/DAP/REPL **391 passed / 19 failed** (diagnosis in progress), P5
websearch **76/76 (246)** plus search/CodeMode **145/145 (571)**, P6 transport **7/7 (23)**, P7 analytics
**16/16 (85)** and stream mux **44/44 (986)**, P8 evaluator **70 passed / 3 skipped** and RC0 **149/149**,
P9 release readiness **107/107** plus identity **3 tests / 59 expectations**, and QA-007 live-question
suite **4/4 (50)** plus Server typecheck exit 0. These are focused offline evidence, not phase acceptance.

V1 remains **PARTIAL / NOT VERIFIED / NOT RELEASED**. P1 Guard/lease/receipt and containment; P2
authenticated HostRun/P8 OwnerLog proof, managed DAG and final settlement; P3/P4 integrated authenticated
journeys; P6 protected credential/live Doctor; P7 integrated stream/automation; P8 trusted attestation,
quotas and repeated workloads; P9 exact artifact closure/candidate qualification; and final integrated
acceptance remain open. Native Windows is unavailable; LM-018 is NOT_RUN. No provider/effect/candidate/
install/signing/publication, commit or push was performed. The mixed unstaged tree and single worktree
are preserved; Cargo work is serialized to P2 only.

## Whole-phase V1 continuation — 2026-10-24

The user requested whole V1 completion and exact Git add/commit/push followed by all open gates.
Whole-phase owners for P1–P9 were dispatched in parallel with disjoint write scopes; current
sessions and acceptance state are in `reports/phases/LEDGER.md`. P1, P2, P3, P4, P5, P6, P7, P8,
and P9 remain unverified; no effect gates were opened.

Fresh handoffs in this wave:

- **P1:** Core denial suites **13/0, 52 expectations**; cross-capability proof still stops at the
  intentionally false PTY readiness gate. Delegated-cgroup matrix and integrated terminal grant /
  profile / receipt / recovery remain unverified. P1 resumed to test its migrated
  `effects_host_process` PreparedBatch fixtures after P2 released Cargo; readiness remains false.
- **P2:** first continuation had no source edits; it confirmed HostRun reconciliation needs a durable
  authenticated `dispatch_idempotency_key` → Run/Task/Attempt, evaluator Session and process-generation
  binding plus a terminal producer and real positive fixture. P8's HostRun receipt is not this
  authority. P2 has resumed its whole phase for independently runnable managed work; Cargo was
  explicitly released. No authority or successful result was fabricated.
- **P3:** **61/61 Core**, OpenCode adapters **80/0/1 todo**, schema **29/29**. Authenticated
  HostKernel query/cursor/recovery, P4 buffer, P1/P2/P8 lifecycle, Guarded patch and real-project
  acceptance remain blocked; navigation stays gated.
- **P6:** **27/0 Core** (107 expectations), **28/0 OpenCode** (120 expectations), offline only.
  `projectCapabilityChips` still lacks a runtime/UI consumer (P5/P7); credentialed SecretBroker/live
  Doctor and managed-profile consumption remain gated. Prior S1 9/0 is not current-revision evidence.
- **P9:** release readiness **79/79**, runtime identity **2 tests / 57 expectations**, installer and
  Python syntax checks green. No source edits. Offline package resolution lacks cached
  `@noble/hashes@2.2.0`, `@horizoncode/client/effect` is unresolved, Nix is unavailable, and
  candidate install/rollback plus legal/signing gates remain open. No network/install/build/sign or
  publication occurred.
- **P4:** OpenCode LSP/DAP/REPL suites **298/0, 1,160 expectations**; TUI editor/helper/settings/
  mounted `/editor` suites **15/0, 47 expectations**. No HostKernel route, subprocess, PTY, workspace
  mutation, Cargo, or full typecheck was exercised. P1/P2/P3/P8 prerequisites still block all
  effectful editor/language-tool claims; native Windows remains unavailable.
- **P5:** web-search/CodeMode local suite **114/0, 353 expectations / 8 files**; focused no-send and
  route-digest tests **2/0, 7 expectations**. Fixed helper asset/manifest contract is source-only;
  real build/install/containment and CM-001..012 remain open. Search and CodeMode gates remain false.
- **P7:** cold AppRuntime still fails with `InstanceRef not provided`; exact callback is unidentified
  and no production fix was made. Core P1-10 caller/DTO remains missing; P7 resumed to work other
  independent activity/transfer/artifact/analytics/automation acceptance without editing the
  P1-owned Supervisor boundary. No P2/P6 rerun or effect gate change.
- **P8:** proposed `HostRunDispatchBoundV1` binds the dispatch key to authenticated Run/Task/Attempt,
  evaluator Session/process generation, owner epoch and frozen pins. A post-commit receipt must
  supply OwnerLog cursor/event digest. P8 owns append/resolve and evaluator consumption; P2 owns the
  HostKernel reconcile route; P1/P2 proof/producer and a real authenticated positive fixture are
  prerequisites. Existing evaluator **39/39** and RC0 input **88/88** do not prove HostRun or real
  measurements. Trusted RC0 and repeated 1/5/10/20 workloads remain unavailable; hard quotas remain
  unsupported.
- **P1/P2 HostRun handoff:** P1 searched the Rust source and found no dispatch-key producer. Its
  `CgroupIdentityV1` and EffectHost can project process/effect/quiescence facts only after P2 persists
  a trusted link; they cannot bind the evaluator Session or dispatch key themselves. P2 owns the
  binding, HostKernel reconcile operation and terminal event. P2 must specify the exact typed P1
  receipt/process projection contract and real authenticated fixture before P1 can wire it. Existing
  P1 effects-host 10/10, cross-capability unit 1/1 and Core boundary 13/0 evidence remain; neither
  readiness gate changed.

### P8 offline acceptance follow-up — 2026-10-24

P8 tightened `scripts/perf/rc0.py` so an attestation must cover each selected Session's exact Linux
PID/start-time generation, in addition to its owner/session/run/revision/receipt/verifier/OwnerLog
pins. Tests reject absent, malformed, stale, duplicate, foreign-session/run, wrong-generation and
caller-claimed `ATTESTED` evidence; a foreign evaluator Run outcome remains UNKNOWN and is not
replayed. Current tests: RC0 **93/93**, evaluator **40/40**, Python compilation passed. The
production `TRUSTED_ATTESTATION_SOURCES` allowlist remains empty, so no trusted attestation or real
measurement exists. JC-RES-012.K/L authenticated ingress negatives and the TypeScript reservation
consumer are still missing. No Cargo, product workload, provider/network, Git, worktree, or cleanup
operation occurred; P8 gates remain closed.

Git is intentionally still untouched: before this wave the shared tree contained 302 modified/deleted
tracked paths, 115 untracked paths, no staged paths and 17 commits ahead of `origin/main`. Owners are
still writing. The explicit user request does not make a blanket stage/push safe; parent will stage
only exact reviewed verified task-owned changes after phase writers stop, and will not push unrelated
or unverified pre-existing commits. V1 remains **PARTIAL / NOT VERIFIED / NOT RELEASED**.

### P9 identity follow-up — 2026-10-24

P9 fixed the SDK-next import edge test-first: `packages/sdk-next/src/index.ts` now re-exports from
`@horizoncode/client/effect`, and `packages/sdk-next/test/import-boundaries.test.ts` passes **1 test / 2
expectations**. The intended export is source-based (`packages/client/package.json` maps `./effect` to
`./src/effect.ts`); client typecheck and local source build pass. The installed SDK-next link is stale
and still points `@opencode-ai/client` at the local client; no `@horizoncode/client` link exists.
Offline install/link refresh remains blocked by uncached `@noble/hashes@2.2.0`, so the full SDK
boundary suite is **4 pass / 1 fail**, and sdk-next typecheck also has the unresolved link plus arity
and server-field diagnostics of unknown baseline. P9 confirms all 59 released tag IDs across 53
files are migrated with Provider/Auth/LLM and vendor identities preserved. No node_modules edit,
install, network, Git, signing or publication occurred. Candidate/Nix/legal/signing/rollback gates
remain open.

### P2/P1 continuation handoff — 2026-10-24

P2 confirms Cargo is released and no P2 Cargo job is running. Managed-control tests passed **41/41
(225 expectations)**; Markdown audit has **0 active blockers** and convergence has **1,300 checks / 0
failures**. P2 continuation 28 records the precise P1-10 request/response contract and a report-level
HostRun binding/projection split, but no compiled DTO, HostRun route, or runtime evidence. P2 is
resuming whole-phase source/test work without Cargo. P1 has taken the sole Cargo slot for the queued
`effects_host_process` PreparedBatch fixture verification and scoped Rust security triage. The
HostRun dependency remains: P2 must implement trusted durable binding/route, P1 a typed projection
over persisted references, and P8 authenticated post-commit evidence consumption; all positive and
negative/restart tests are still required. Terminal gates remain false.

### P1 Rust acceptance continuation — 2026-10-24

P1 ran the single Cargo slot sequentially from `kernel/` with repo-local `TMPDIR` and
`CARGO_TARGET_DIR=../target-p2 CARGO_BUILD_JOBS=1`. The queued `effects_host_process` rerun first
failed 7/10 on three `SUN_LEN` bind errors caused by a fixture socket path exceeding Linux's 108-byte
limit; P1 fixed only the fixture (compact hex child name, explicit 12-byte name budget, pre-spawn
<108-byte assertion) and reran to **10/10**. Also green on the current tree: `effect_host_principal`
**11/11** (previously 2/9 pre-migration), library `guard`/`effect_host`/`cgroup_v2`/`terminal_process`
**79/79**, and `direct_attempt_rpc` **10/10**. `tool_batch_guard_matrix` 3/9, `host_terminal_process`
2/3 and `host_terminal_events_process` 0/1 are the same intentional P2-owned
`capability_unavailable` readiness-false denials; no assertion was relaxed and both gates stay false.
P1 could not implement the HostRun process projection: no persisted HostRun binding exists and
`effect_challenges` rows carry no per-effect Run/Task/Attempt/Session/epoch/process-generation pins.
P1 released Cargo to P2, which now owns compiling the real binding/DTO/route. P1 remains PARTIAL.

### P5 integration continuation and parent overlay fix — 2026-10-24

**P5** re-inspected the Core CodeMode seam: `tool/tool.ts:44-70` carries the typed
`dispatchPreparedToolBatch` DTO and `tool/registry.ts:32,112` plumbs it into the tool Context, but
`packages/core/src/session/runner/llm.ts:686-699` is still the fail-closed stub and has no consumer,
so P5 did not fabricate an adapter. P1's authenticated HostKernel surface now exists at
`supervisor.ts:6105-6230` (`codemode_prepare_wave`, `codemode_settle_tool_results`,
`codemode_wave_receipts`, `codemode_cancel_wave`). P5's test-locked contract finding: the Core DTO
has no `batchID`, `waveIndex`, `requestId` or per-row `receiptKind`, so callback rows can never be
treated as §37.24 receipts — a Core adapter must additionally project `codemode_wave_receipts`.
Independent P5 hardening (test-first, two real REDs): fixed-helper enablement now requires an exact
`sha256:` manifest digest, one-shot batch/receipt bindings, empty BYO `cascadeRef` rejection,
exported frozen helper limits (32/wave, 64 waves, 512 KiB wave, 64 calls, 1 MiB script, 64 KiB
output, 30 s). Evidence: P5 group **128/0, 430 expectations / 8 files** (was 116/0/362), changed
files **98/0, 340 expectations**, P7 `tool-batch` consumer **71/0, 322 expectations**, focused tsgo
**0 P5 diagnostics**. All gates remain false; CM-001..012 unrun.

**Parent structural fix (blocking any honest commit):** `scripts/architecture/audit_overlay_visibility.py`
reported `hidden_changed=26` — 26 first-party overlay deltas existed but were hidden by the blanket
`*` ignore, so a commit would silently have omitted HorizonCode behavior — plus 32+ generated
`kernel/tmp-p8` and phase-scratch files miscounted as new source. Fixed test-first: the auditor now
classifies exact `tmp-p<N>` and `.agent-tmp`/`.p7-sandbox`/`.p9-*`/`.p9probe` phase scratch (4 regression tests,
RED proven against the pre-fix HEAD implementation), and `.gitignore` gained exact `!` entries for the
26 delta files plus 7 parent directories that contained no tracked file (children cannot be
re-included without them). Re-run after fix: overlay **hidden_changed 0 / hidden_new_source 0 /
stale_unignore 0**, Markdown **0 active blockers**, convergence **1,300 checks / 0 failures**.

## Parent continuation — 2026-10-24 (activity progress, selector projection, read-batch context)

Three bounded gaps are now implemented and focused-tested; none unlocks an effectful route.

- **Activity digest (§31.22):** `packages/tui/src/component/activity-cards.ts` projects redacted
  `progress` cards with `durationMs`/`pathRef`/`lineStats`/`receiptState`/`fidelity`/`artifactRef`;
  `activity-stream.tsx` renders `Reasoning · 1.2s` and tool durations. Focused TUI tests **9/0,
  73 expectations**; TUI typecheck **exit 0** after three stale test-fixture type fixes.
- **Delegation selector truthfulness:** `tool/registry.ts` lists only immutable `AgentProfileV2`
  selectors and reports when none are configured, rather than advertising built-in names that
  cannot dispatch. New test **2/0, 6 expectations**; existing registry suite **13/0, 42
  expectations**. Task metadata now carries the child agent/profile for activity cards.
- **P1-10 read boundary:** `packages/core/src/session/supervisor.ts` allows private `repo_read`
  context for exactly `effects.v2/prepare_tool_batch_read`, body Session/Location equality and
  1–8 calls. New test **3/0, 10 expectations**; Core typecheck **exit 0** (with a P3 RepoIntel
  decimal-coverage conversion, focused **2/0, 5 expectations**).

Delegation remains read-only: direct child turns (`DIRECT_CHILD_TURN_RPC_ENABLED=false`), child
effects, resume/follow-up, managed Task dispatch, and background-by-default remain gated. P7 still
must implement the TypeScript P1-10 caller/DTO; AppRuntime RED, P2 HostRun reconciliation, P8
trusted measurements, provider E2E, and release/legal/signing gates remain open. V1 is
**PARTIAL / NOT VERIFIED / NOT RELEASED**.

## P8 offline acceptance follow-up (second wave) — 2026-10-24

- **JC-RES-012.I cross-language consumer closed on the TS side:** new
  `packages/core/src/v1/resource-reservation-wire.ts` (strict codec for the 7 reservation states, 4
  pressure states and 9 budget dimensions with `Schema.Literals`) plus
  `packages/core/test/reservation-wire.test.ts` reading
  `kernel/tests/fixtures/reservation-wire-v1.json` — **9/0, 89 expectations**, `packages/core` tsgo
  **0 errors**. Forbidden aliases (`ACTIVE`, `UNKNOWN`, `SOFT`, `HARD`, lowercase/camelCase) are all
  rejected; the fixture's `consumers.typescript` now names the module. P8 also updated the Rust
  assertion in `kernel/tests/support/jc_res_012_wire_tests.rs`, which remains **uncompiled** until
  the Cargo slot is used — routed to P2 with the assignment.
- **RC0 attestation now has a real keyed verification path instead of a syntax check:**
  `scripts/perf/rc0.py` requires an allowlisted source **and** a registered verifier for that source,
  a domain-separated canonical payload digest (source, commit, Session/Run joins, exact Session→
  PID/start-time generations, HostRun receipt refs, verifier-evidence refs, OwnerLog digests) and a
  matching `hmac-sha256` MAC, with repo-contained no-follow single-link `0600` 32–64-byte key
  loading and deny-on-verifier-error. Public-key/Ed25519 is deliberately rejected as unsupported
  rather than hand-rolled, and no dependency was added. `TRUSTED_ATTESTATION_SOURCES` and the
  verifier registry remain **empty**, so RC0 is still honestly **NOT_ATTESTED**.
- **Evaluator fail-closed:** `eval_harness.py` requires HostRun receipt and verifier evidence to be
  distinct refs, rejects contradictory PASS/FAIL verdicts and security/false-completion mismatches,
  and rejects any `resourceUse` beyond `{"status":"UNKNOWN"}`; `summarize_pairs` requires complete
  evidence.
- **JC-RES-012.C–J** transition relation audited against §11.20/§45 with no divergence (no
  `RESERVED→QUARANTINED`, terminals one-way); offline math negatives added for PSS/RSS aggregation
  above 2^53 and at `u64::MAX`. **K/L** remain open pending authenticated ingress. No 1/5/10/20
  harness was scaffolded: the only owner-sample producer is P2's authenticated managed route
  (`host_kernel.rs:17259`) and there is no exporter/Core orchestrator, so a harness would only
  mislabel mocks.
- **Evidence:** RC0 **109/109** (was 93), evaluator **43/43** (was 40), Python compile OK, Markdown
  **0 active blockers**, convergence **1,300 / 0**. RED captured for each before implementation.

## P7 continuation 23 — P1-10 caller landed; AppRuntime narrowed — 2026-10-24

- **P1-10 Core read caller is implemented** in `packages/core/src/session/direct-read-batch.ts`
  (+ test), honoring all five parent rulings: no `supervisor.ts` edit (uses public
  `requestHostKernel` + private `repo_read` context), local strict request validation before any send
  (`validateDirectReadCallsV1`), execution order `classify → feature → principal → validate →
  register → send → execute → snapshot → publish`, a post-read fence against
  `directSessionWorkspaceSnapshot` (`sessionID`/`locationID`/`workspaceRevision` compared to the
  prepare response **and** every row `revision`) that denies the whole wave with `unknown:true`,
  `replay:"forbidden"` and no partial `calls`, and `packages/core/src/tool/registry.ts` left untouched
  because the fence proved sufficient (the proposed `ExecuteInput.readAdmission` shape is recorded for
  sign-off, not applied). Evidence: **27/0, 447 expectations**; non-vacuity proven by mutation
  (moving the snapshot before execution made the strict-order test fail, then it was restored).
- **Two P1-owned seam blockers reported (not edited by P7):** (1) `HostKernelClientImpl.request`
  (`supervisor.ts:4134-4165`) accepts `repo_read` only when `isRepoIntelRead`, so the allowlisted
  `prepare_tool_batch_read` is rejected at the client and can never be sent; (2) the envelope
  `requestID` minted at `:4167` is discarded at `:4332-4341`, so Core cannot bind row `requestID`
  exactly as Rust does. Both routed to P1 with exact test-first instructions.
- **AppRuntime:** the cold `InstanceRef not provided` RED no longer reproduces —
  `test/effect/instance-state.test.ts` is **3/0** with all probes removed. The failure narrowed to
  `Service not found: @opencode/v2/Plugin` from `Agent.state` (`agent.ts:215`) via
  `InstanceState.get:38`: `agent.ts:224-225` requires `PluginV2`/`Reference` inside the initializer
  while `Agent.node` deps (`:679`) omit them under `requireServicesAt:"lookup"`. A contract test
  proves the cache keeps construction context, so it is a graph-dependency gap; P7 has been authorized
  to apply the narrow fix test-first and only then rerun P2 `task.test.ts` and P6 `config.test`.
- **CodeMode adapter not built:** the dispatch DTO has no `batchID`/`waveIndex`/`requestId`/
  `receiptKind`, so it would need P1's `codemode_wave_receipts` projection first. Exposure stays false.
- Fresh independent acceptance on the current revision: core **27/0**, opencode
  automation/checkpoint/artifact/registry **54/0**, TUI stream/activity/analytics/render/scroll
  **62/0**. No Cargo, provider, network or package-wide typecheck; no gate opened.



## P1 seam fixes — P1-10 path now wired end-to-end in source — 2026-10-24

P1 closed both blockers P7 reported, test-first (exact evidence in `reports/phases/P1.md` §34):

- **Client gate:** `HostKernelClientImpl.request` (`supervisor.ts:4134-4165`) now admits the
  allowlisted `effects.v2/prepare_tool_batch_read` under private `repo_read` context — negotiated
  `effects.v2` feature **and** `validDirectReadBatchAuthenticatedRequest` (body Session/Location
  equality, 1..8 calls) — while every other `effects.v2` operation, a feature-less negotiation, a
  scope mismatch and a missing context stay denied. `requestHostKernel` carries the same disjunct as
  defense in depth. RED reproduced the exact `authenticated read context is unavailable or invalid`
  at `supervisor.ts:4176`.
- **Envelope identity:** optional `options.requestID`, validated `^[A-Za-z0-9._:-]{1,256}$` and
  accepted only on the read path, rejected **before any frame is written**; absent ⇒ legacy
  `req_<uuid32>`. Wire DTO untouched and no other caller passes it yet. This lets Core bind each
  projection row's `requestID` exactly as Rust does.
- **Fail-closed principal:** `packages/core/src/session.ts` now uses `Effect.serviceOption` at
  create/prompt/resume/revert.stage/revert.clear — a missing `TrustedPrincipalContext` is a typed
  denial that precedes any mutation, and `host_os` is never fabricated.

Evidence: `session-supervisor-read-batch-client.test.ts` **10/0, 47 expectations**; combined
read-batch-client + read-batch-context + P7's `session-direct-read-batch` + launch **53/0, 541
expectations** (P7's 27/0 intact); `session-revert-principal` **3/0, 11**; process-guard/Bash/ripgrep
**10/0, 42**. Both terminal readiness flags remain **false**; no Cargo run by P1 (P2 held it).

**Routed from P1:** `packages/sdk-next/test/embedded.test.ts` is **1 pass / 3 fail / 2 errors** and is
*not* fixed by the principal change — `createEmbeddedRoutes` runs `authorizationLayer` with auth not
required and the web handler has no `remoteAddress`, so `isTrustedLoopbackPeer` is false and Core's
resume guard correctly denies. Parent ruling sent to P6: thread the **real** peer address if the
transport carries one; if it does not, the request is unauthenticated and must **stay denied** with
the tests corrected to express that — never weaken the guard or fabricate `host_os`.



## A1 whole-repo typecheck inventory — 2026-10-24

Artifacts: `reports/typecheck-integration-a1.txt` (raw, Run A baseline + Run C final, logs in
`.tmp-a1/logs-c/`) and `reports/a1-ownership-triage.md` (owner table, merged with the parent routing
draft).

- **Run A baseline: 60 diagnostics / 4 packages failing** (schema 7, opencode 28, sdk-next 23,
  server 2; core/tui/llm/protocol clean).
- **Run C final: 25 diagnostics / 2 packages failing** — `packages/core` 4, `packages/opencode` 21.
  Clean: **tui, llm, server, protocol, sdk-next, schema**.
- **40 rows cleared:** A1 fixed **15** as test-fixture defects (schema 7, opencode 8 — duplicate keys,
  missing mock params, branded `SessionID` fixture values rather than a cast), other owners **25**
  (sdk-next 23 from the authorized workspace install, server 2 from P6's `ServerAuth.primaryOnlyInfo`).
  **5 new** rows appeared during the session while P7 landed the P1-10 caller.
- **Routing applied:** P7 14, P6 8, P9 3. A second P7 helper session took an explicit disjoint set of
  8 (read-batch test, checkpoint handler, managed-artifact-search) so two sessions never write the
  same file; the original P7 session keeps `task.ts`, `repo-tools.ts`, `instance-state.test.ts`.
- **Two non-diagnostic product findings routed beyond typecheck:**
  1. `packages/schema/test/agent-profile-v2.test.ts:92,23` — strict contract **11 pass / 1 fail**
     (`PositiveDecimalU64` `$ref` vs `integer`) → P6, fix against §12/§17.13 authority, not by
     loosening the contract.
  2. **14 failing `tool.task authenticated dispatch` product cases** at
     `packages/opencode/src/tool/task.ts:276` → P7 with P2 support; assertions must not be weakened —
     if dispatch truly cannot authenticate today, the test must express the fail-closed state and the
     prerequisite moves to the ledger.
- B1 is **not** green: 25 diagnostics remain plus both product findings.



## P9 install-graph proof — 2026-10-24

P9 executed the user-authorized install under strict sequencing (waited for A1's live `tsgo` to
finish, verified only task-owned records, no host-wide process touched):

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` (repo root) | **exit 0**, bun 1.4.2 — resolved/downloaded/extracted 21, postinstall `fix-node-pty` + `husky`, **2427 installs across 2700 packages, no changes**, 11.39 s |
| `sha256sum` over `bun.lock` + 27 manifests, pre vs post | **byte-identical** — install changed no lockfile or manifest |
| Workspace link | `sdk-next/node_modules/@horizoncode/client -> ../../../client` resolves `src/effect.ts`; there were **zero** `@horizoncode/*` links before |
| SDK boundary suite | **4 pass / 1 fail → 5 pass / 0 fail, 11 expectations** |
| `packages/client` typecheck | **exit 0** |
| `packages/sdk-next` typecheck | **23 → 1 diagnostic** — only `src/opencode.ts(32,85) TS2554`, the P1-routed `TrustedPrincipalContext` arity. Cleared: 4 `TS2307` (install), 16 `embedded.test.ts` cascades, 2 `TS2739` (P6's `ServerAuth.primaryOnlyInfo`) |
| sdk-next full suite | 5 pass / 4 fail — all four are `ForbiddenError: Authenticated principal required`, i.e. the same P1-routed residual |

Honest residue: the stale `sdk-next/node_modules/@opencode-ai/client` entry is still on disk (Bun did
not prune it); nothing resolves through it and P9 did not hand-delete it.

**Real P9 defect fixed test-first:** `_resolve_dependency` rejected any symlink component while
Bun's isolated store symlinks everything, producing a false "100 required runtime dependencies were
not resolved" blocker after a clean install. RED (`0 != 2`) → containment-by-resolved-target fix →
GREEN, with the `test_runtime_dependency_symlink_cannot_escape_audited_root` negative intact.
Release readiness **81 → 82/82**; the audit now sees **869 packages, 0 unresolved required, 0
inventory errors** (73 unresolved optional, non-blocking).

Release gates moved truthfully rather than silently: audit **14 → 15** blockers, gate **19 → 20** —
one blind blocker replaced by two real ones (4 packages missing license metadata, 58 missing direct
LICENSE/NOTICE). `publication_performed=false`, `signature_created=false`, signing/update
`UNAVAILABLE`, install matrix `NOT_RUN`, candidate **NO-GO**. Nix and shellcheck are absent from this
host. Overlay exit **0, hidden 0/0**; Markdown **0 active blockers**; convergence **1300/0**.

Cleanup: removed only P9's own scratch (`.tmp/p9-qualification` 1.4 MB + empty `p9-qual-matrix` 4 KB);
preserved `node_modules` 2.5 GB, `kernel/target` 1.8 GB, `target-p2` 4.8 GB; **827 GB free**.

## P9 release/identity continuation — 2026-10-24

- **sdk-next diagnostics baselined as pre-existing, not rename-caused.** 23 diagnostics: 4 unresolved
  client `TS2307`, one `src/opencode.ts(32,85) TS2554`, 16 `test/embedded.test.ts` cascades, 2
  `packages/server/src/routes.ts(42,48) TS2739`. P9 reproduced the arity/reviewer errors with a
  temporary probe compiling `@opencode-ai/server/routes` + `core/permission/saved` with **no client
  import**, then removed the probe. `routes.ts`/`auth.ts` are unmodified vs HEAD, yet the committed
  `ServerAuth.Info` requires `reviewerUsername`/`reviewerPassword` while both `configLayer(...)` sites
  pass only `username`/`password`, and the pinned snapshot has no reviewer fields — owner is P6/core
  server-auth. The arity residual needs the local first-party `TrustedPrincipalContext` provided only
  on some branches of `packages/server/src/middleware/authorization.ts` — owner P1/P6. No fix applied
  outside ownership; `embedded.test.ts` errors are downstream of the unresolved import.
- **Real P9-owned lockfile defect fixed test-first:** `bun.lock` importer `packages/opencode` still
  recorded `./bin/opencode` while the manifest and distribution audit expect `./bin/horizoncode`. New
  `test_workspace_lockfile_importers_match_manifest_identity` (strict JSONC reader, name/version/bin
  parity across all 36 importers, orphan-importer rejection, product-bin pin) failed RED on exactly
  that row, then passed after the two path strings were corrected. No resolution/integrity row touched.
- **Workspace link blocker narrowed:** of 36 manifests exactly one stale local link exists
  (`packages/sdk-next/node_modules/@opencode-ai/client -> ../../../client`); `@horizoncode/client`
  has no link anywhere. Manifest graph, glob, lock importer edge and both workspace resolutions are
  already correct, so no source edit can materialize the link — only install can, and
  `bun install --dry-run --offline --frozen-lockfile` stops at `no cached manifest for "@noble/hashes"`
  even though the package is extracted. A `tsconfig` `paths` shim was rejected: it would green tests
  while leaving the install graph broken.
- **Evidence:** release readiness **81/81** (was 79/79), client typecheck **exit 0**, SDK boundary
  **4 pass / 1 fail** (bundle test only), `bash -n install` + `py_compile` exit 0, `audit_distribution`
  BLOCKED (14 blockers), `release_gate` exit 1 BLOCKED (19 blockers), Markdown **0 active blockers**,
  convergence **1,300 / 0**. New static Nix/container control test asserts one `horizoncode` runtime
  with `hzcode`/legacy symlinks, `--push` rejected before Docker, local-only registry, no `docker
  push`/`:latest`.
- **Cleanup:** removed only P9-owned scratch after confirming no process used it —
  `packages/opencode/packages` (19 MB / 858 partials), `packages/sdk-next/.p9probe/`, two
  `kernel/target/p9-*` entries; `packages/opencode` 382 MB, `kernel/target` 1.8 GB preserved, 828 GB
  free.

**Remaining gates:** offline `@noble/hashes@2.2.0` manifest → frozen install → SDK boundary/typecheck;
P6/core reviewer fields + `TrustedPrincipalContext`; exact clean candidate plus a genuine previous
binary for install/upgrade/rollback and Linux/WSL acceptance; Nix unavailable; DEC-V1-11
grant/notices and DEC-V1-12 signing remain hard blocks. Candidate stays **NO-GO**.

## P9 continuation — 2026-10-24 (generated-client import edge)

P9 reproduced the three prior `sdk-next` typecheck diagnostics exactly before
editing: `src/opencode.ts:32` (`web.handler` arity) and `packages/server/src/routes.ts`
missing `reviewerPassword` / `reviewerUsername` at lines 42 and 48. Their
pre-rename baseline remains unknown; none is labeled pre-existing or rename-caused.
Source inspection found and fixed a separate P9-owned identity break: `sdk-next`
still imported `@opencode-ai/client/effect` after its workspace edge moved to
`@horizoncode/client`. The collision regression now asserts the new import and
passed test-first (RED before, GREEN after). `packages/client` typecheck passes.

The fresh post-fix `sdk-next` typecheck cannot yet resolve
`@horizoncode/client/effect` in the existing install/link state and reports
cascading `embedded.test.ts` typing errors alongside the arity and server
reviewer-field errors. `bun install --frozen-lockfile --offline` is blocked by
uncached `@noble/hashes@2.2.0`; no online retry. Lock importer and workspace
resolution are textually present, but frozen resolution/lock consistency is not
verified. Next candidate layer is local `@opencode-ai/sdk-next`; mapping found
its manifest/lock identity, first-party Service identifier and CONTEXT mentions,
with no vendored collision in searched local source. Defer it until the client
workspace edge resolves offline and the lock is verified. Exact P9 ledger is in
`reports/phases/P9.md` §11. No Git, network, publication, or signing operation.

## Live update — 2026-10-24 (P2 Rust wave triage)

**P2 continuation 10 correction:** The deferred-location recovery test failure was
caused by its fixture registering a direct-Session Location without a
`workspaceID`, not by a principal mismatch. The test now uses the same named
workspace on registration and re-registration; focused unit test **1/1**,
`direct_attempt_rpc` **10/10**, and `managed_control` **39/39** pass. The
Location owner check remains unchanged. P2 still owns Cargo and has **not
released** it. The two managed-delegation admission failures still require
reconciliation of the synthetic P8 lease fixture with the current pre-admission
lease contract; do not weaken lease validation. Remaining P2 phase acceptance
is open as recorded in `reports/phases/P2.md` continuation 10.

P2's final combined Rust wave has completed and **failed** (`target-p2/p2-wave-final.log`, EXIT 101):
lib 477 pass / 7 fail; `direct_attempt_rpc` 5 pass / 5 fail; `effect_host_principal` 2/9;
`effects_host_process` 2/8; `host_terminal_events_process` 0/1; `host_terminal_process` 2/1;
`tool_batch_guard_matrix` 1/8. The log contains explicit `capability_unavailable` PTY failures while
P1's readiness gate is false; do not "fix" these by enabling terminal execution. P2 has been sent the
exact failure inventory for owner triage and repair; Cargo remains assigned to P2 until its owned
failures are fixed and it explicitly releases the slot. P8's Rust matrix is queued behind that release.
At the last snapshot no Cargo/rustc/tsgo/bun-test process was running; P7/P1/P9 are continuing disjoint
work. Disk: 829 GB free; preserve `kernel/target` 1.8 GB and `target-p2` 4.4 GB.

P9's latest independent pass passed `bash -n install` plus three focused installer tests (dual-command
install/upgrade, dry-run, alias refusal); no files changed. Nix evaluation is unavailable (`nix` not
installed). Candidate install/upgrade/rollback still awaits integrated P1–P8 acceptance; package identity
migration waits P7's package-input release and a deliberate resolution of the local-vs-vendored
`@opencode-ai/client` collision. No publication: licensing/signing remain unresolved.

**Newest owner updates:** P1 fixed `packages/core/src/tool/bash.ts` fail-closed principal provision; its
focused suite is **3/3**, and the stale `terminal-run-live` revision negative is rebased onto canonical
`bind_direct_attempt_effects` (runtime still waits for P2's kernel binary). P7 repaired its three new
Core diagnostics in `message-updater.ts`, `projector.ts`, and `transfer.ts`; fresh serialized A1 Core/TUI
typechecks are in progress, with TUI's compiler active at the last snapshot. P7's OpenCode package
typecheck is **65 total / 0 P7-owned**; its focused runner and transfer journeys passed 125/125 combined.
P2 has been given P1's exact failure characterization: B1 prepares now succeed, and five direct-RPC
tests have stale expectations for the new `prepared + capabilityLeaseDigest` quiet-admission result;
false-gated PTY failures remain intentionally unavailable. P2 retains Cargo ownership during repair.

The Markdown audit is **0 active blockers**, convergence **1300/0**, and overlay audit **0 hidden
changed/new-source/stale-unignore**. Overlay fix: the auditor now classifies exact `.tmp` directories as
generated scratch (regression test 1/1), and the new P7 compile-boundary test is Git-visible.

## Acceleration update — 2026-10-24 (P6 returned; research recommendations surfaced)

P6 has now returned **PHASE_PARTIAL** with its S1 five-module acceptance green at **9/0 (41
expectations)** and focused phase suites green (exact breakdown in `reports/phases/P6.md`). Credentialed
SecretBroker/live Doctor, managed-profile consumption, and integrated E2E remain gated; no live or paid
provider calls were made. P2 currently owns the only Cargo build slot for its final Rust wave, and P7 has
the package-wide `tsgo` slot. P1 and P9 have been resumed on independent work (P1: `bash.ts` typecheck
root; P9: release/identity work that does not collide with active package inputs). P8 is ready for its
Rust acceptance immediately after P2 explicitly releases Cargo.

The promised research comparison is in `reports/research/competitors-cursor-devin.md` §§11–13. Short
version: HorizonCode's architecture is already stronger on single-Guard effects, per-effect fresh policy,
lease/receipt/UNKNOWN recovery, and worktree ownership; its largest competitive gap is **published,
implementable contracts**, not another authority/runtime. The best V1 candidates are (1) publish a
headless NDJSON turn protocol with terminal-receipt semantics, (2) freeze the worker claim/queue wire
contract, (3) specify restrictive-wins sandbox/config merge algebra, (4) add trusted, default-off Cursor
rule ingestion, and (5) machine-check Run structured output. Hook execution and machine-readable session
reason codes follow. These are **research recommendations only**—not runtime scope changes or permission
to weaken Guard. Deliberately reject LLM auto-approval, fail-open security hooks, remote feature gates,
boot-stale policy, and at-least-once prompt delivery without idempotency. See §12 for owner/effort/schema
details and §13 for the full reject list.

## Live update — 2026-10-24 (P2 source fix, P9 map, overlay gates)

The A1 typecheck and R3 research sessions have now returned; P9 returned its dependency map. A1's
second independent run confirms Core **4**, TUI **1**, all other-owned; parent assigned the
`packages/opencode/src/effect/instance-state.ts:35` residual exclusively to P7 because P7 owns the
package-wide typecheck closure (P6 must not edit it). P1 owns `packages/core/src/tool/bash.ts:68`.
The directAttempt strict-fields test remains unverified until a kernel binary exists.

P2's B1 root-cause fix is now present in source: `kernel/src/host_kernel.rs` parse and persist checks
both use SHA-256 for `turnContextDigest`; the source comment identifies the Core producer as SHA-256,
while the separate kernel-produced `call_manifest_digest` stays BLAKE3. This resolves the observed
algorithm contradiction in source, **not yet verified**: P2 currently owns the only Cargo job, running
`cargo test --lib unavailable_registered_location_is_deferred` in `target-p2`. P6 has one focused
`tsgo -p tsconfig.p6-focus.json`; P7 has one focused `session-runner-compile-boundary.test.ts` run.
Do not start another Cargo/tsgo/full test job until these owners release their slots. P1/P8 Rust suites
remain queued behind P2's explicit Cargo release.

R3 is complete at 1,713 lines (Cursor CLI no-auth observations + Devin docs/OpenAPI); P9 returned
PHASE_PARTIAL after an inventory-only Stage-2 identity map, identifying a local-vs-vendored
`@opencode-ai/client` collision. No P9 files changed and no package/lockfile migration started; it waits
for P6/P7/A1 package inputs. Overlay audit now passes `hidden_changed=0 / hidden_new_source=0 /
stale_unignore=0`; Markdown audit `ACTIVE_BLOCKERS=0`; convergence `1300/0`. Remaining scope and legal
gate unchanged: finish P1/P2/P6/P7/P8 acceptance, identity Stage 2, candidate/install qualification,
free-model E2E, full integrated acceptance; user license/notice decision still blocks distribution.
V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Current checkpoint — 2026-10-24 (second restart; A1 and R3 handoffs)

After the second server restart, re-read the required architecture/status sources and reloaded Engram.
Git MCP confirms `main`, `origin/main`, 17 commits ahead, **nothing staged**, 296 changed/untracked
paths, no conflicts. Repository disk check: 830 GB free; `kernel/target` 1.8 GB and `target-p2` 3.9 GB
(retain both caches). At one inspection, P6 auth tests, P7's `#` filename test and one `tsgo` were
running; a later process check found them all exited. Do not assume their results—read phase reports.

**A1 returned partial, not green:** `reports/a1-core-tui-convergence.md` establishes Core **6→4**,
TUI **1→1**; the 5 residual diagnostics are all other-owned: `packages/core/src/tool/bash.ts:68`
(P1, also sole TUI error), plus P7's `packages/opencode/src/agent/agent.ts:512,552` and
`packages/opencode/src/effect/instance-state.ts:35`. A1 fixed two stale tests in
`packages/core/test/terminal-run-live.test.ts`, but runtime proof is blocked until P2's `hz-kernel`
binary exists. That report also finds a security-negative fixture that sends unknown `directAttempt`
to `prepare_tool_batch`; Rust strict-fields rejects it before the intended revision assertion. P1/P2
must rebase that test onto `bind_direct_attempt_effects` once the kernel is available; denial still
holds, but the current assertion is not yet runtime-proven.

**Research R3 has landed:** `reports/research/competitors-cursor-devin.md` is 1,713 lines; 19 Cursor
help surfaces were observed unauthenticated, while Devin is documented/OpenAPI-only. All four research
artifacts are complete, with exact `.gitignore` exceptions. Research remains observational only; no
competitor recommendation changes runtime scope without §17 + topic owner + §32.

Owners have been re-based again without redoing prior green suites: P1 resumes the A1 `bash.ts` row
and full acceptance, but waits for P2's Cargo release; P2 rechecks/finishes B1 plus its single Cargo
wave; P7 continues the three typecheck residuals and original P7 backlog; P6 closes S1/focused suites;
P8 prepares and then runs its Rust acceptance after P2; P9 now has a fresh whole-phase owner for the
staged identity/package/release lane. Current unfinished critical chain: P2 B1/test-target compile →
P1/P8 Rust suites → P7/P1 typecheck residuals → stage-2 identity migration → full typecheck/release
qualification → authorized free-model E2E → integrated acceptance. License/notice decision remains
deferred; no public distribution. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Current checkpoint — 2026-10-24 (post-restart re-basing)

The server restarted mid-wave and cancelled **all eight** children. Verified before any re-dispatch, so no
work was repeated and no result was invented: `reports/research/` did not exist (no research output lost);
`repo_take/re-sandbox/` was intact — Claude Code **v2.1.310** at `npm-global/bin/claude`, the **9.7 MB**
official `claude-code/docs/llms-full.txt` corpus, REA installed, working `env.sh`; no `cargo`/`rustc`/
`tsgo`/`bun test` process was running; 291 dirty/untracked paths, nothing staged, `main` at `44f8b5f2a`,
17 commits ahead of `origin/main`.

Re-based owners (each received its already-landed evidence back verbatim so it resumes rather than
re-derives): **P2** `ses_e937b302affeKsOR3vmHl9WZ3V` — sole Cargo slot, B1 digest wall + `direct_attempt_rpc`
+ its 25 whole-lib failures; **P7** `ses_e937b3029ffethV0uwoBHXHiSK` — own supervisor-mock regression,
`prompt.ts` 2 + `goal-review.ts` 1, CTX-019 overlap/speed consumers, durable message-append; **P6**
`ses_e937b3010ffe6z0PlazQV4wLaK` — S1 `WebSearchRuntime` layer gap to 9/0; **A1 (new)**
`ses_e937b3012ffe1XiN1EnfOAFCtu` — `packages/core` + `packages/tui` typecheck to zero (P7 owns
`packages/opencode`). Research lanes, observational only and explicitly barred from decompilation, source
reconstruction, auth/licence circumvention and code reuse: **R1** `ses_e937b302cffePPOqZUWyYcXwHG` Claude
Code docs+CLI+HLD/LLD; **R2** `ses_e93792458ffe4XPIHvhbUj7Q5D` published Agent SDK typed contracts; **R3**
`ses_e93792456ffem4yYzmru4Irtts` Cursor CLI + Devin; **R4** `ses_e93792441ffeYpnQ78u4p9YorJ` DeepSeek
API/harness + Cordis. Live table: `reports/phases/LEDGER.md`. **R1, R2 and R4 have returned complete**
(`reports/research/claude-code-architecture.md` 1,457 lines; `claude-code-sdk-contracts.md` 1,981 lines;
`deepseek-harness-cordis.md` 454 lines); R3 (Cursor CLI + Devin) is still running. Gates on the three
artifacts: Markdown **0 blockers**, convergence **1300/0**, overlay clean for `reports/research/**`.

Critical path is unchanged: **B1** (`host_kernel.rs:19558` sha256 vs `:35183` blake3 on the same
`turnContextDigest`) gates 25 P1 tests; then `packages/opencode` 90→0 and Core/TUI→0, the identity stage-2
package layer, the candidate build, and the free-model E2E. **V1 remains PARTIAL / NOT VERIFIED / NOT
RELEASED**; public distribution still waits on the user's licence/notice decision.

## Current continuation checkpoint — 2026-10-23 (provider-source wave + parallel build)

**Provider-source decision implemented.** User direction: provider list/auth/connection recipes come
from the pinned OpenCode provider layer as a standalone SDK; models.dev is advisory metadata only
with one bounded startup refresh and cached fallback; `opencode` (OpenCode Default) / `opencode-go`
stay explicit identities; the OpenCode free-model route is the authorized V1 E2E smoke path. Landed:
`arch_V1/17` A-V2-27 amendment, `arch_V1/20` §20.16 SDK boundary + update procedure, `arch_V1/42`
SRC-027/028, `arch_V1/16` note, `arch_V1/32` P6-PROVIDER-004 row + dated evidence note,
`repo_take/NOTES.md` take-map, new `packages/opencode/src/provider/UPSTREAM.md`, and the startup
`refresh()` fork in `packages/core/src/plugin/models-dev.ts` with a new 3/3 test. Gates after edit:
markdown 0 blockers, convergence 1300/0, overlay 0-0-0, core typecheck 100 (none in changed files),
models-dev tests 2/2 and 3/3. P6-PROVIDER-004 integrated cases and the real free-model journey are
still OPEN.

**Active whole-phase owners (2026-10-23 — seven concurrent agents; OpenCode imposes no subagent-count cap, the real serialization is one Cargo slot + one full-typecheck slot + disjoint writes + 6.0 GiB host RAM):** P1
(ses_e97fdf4c3ffekTjdOWVZZzH2FG) **holds the sole Cargo slot** and is running its Guard/EffectHost/
cgroup/terminal/workspace_command_profile/http_execution lib + integration suites after resolving the
Full Access prepared-editor cancel disposition and the `prepare_external_editor_execution` XOR-gate
defect (4 new TDD tests, not yet run). P2 (ses_e961dbfe8ffeksMLE4073bBWw1) is on source work until
P1 releases the slot: its Rust wave already passed `cargo check --tests` **0 errors**, P8 lib modules
25+21+12+4, managed_control 39/39, unix_peer 5/5, unix_hello 4/4, and it fixed two real managed-control
bugs; it is now repairing 7 `direct_attempt_rpc` drifts plus the `managed-control.ts:7939` status
widening behind ~44 of P7's handler errors. P6 (ses_e961dbfd5ffeCC2ADFscKeTji1) was resumed on its
independent work now that AppRuntime runs: the last `config.test` permission residual, the 14 legacy
`getLanguage` provider tests (one `be4f48c4d` fail-closed root), and the single `Schema.Union` array
fix in `groups/control-plane.ts` that blocks the S1 HTTP QA modules.

**P5 returned PHASE_PARTIAL with the AppRuntime unblock verified:** `websearch.ts` eager-init fix
RED→GREEN — `config.test` **0/112 → 111/112**, registry **0/12 → 12/12**, AppRuntime now VERIFIED
in-repo (all config/registry tests build the full `AppLayer` with no `InstanceRef`), codemode
**263/0** + typecheck exit 0, P5 10-file suite **179/0**, plus 4 new coverage tests (no keyless→paid
upgrade, Retry-After cooldown, 429-only failover, bounded-transient-retry rejection). P5's residual
config failure is P6-owned; its remaining blockers are all cross-phase; search + CodeMode gates stay
false.

**P7 is now ACTIVE** (it was queued): parent added §42 SRC-029, so P7 holds the P3-11 write grant
and is implementing `packages/core/src/session/transfer.ts` plus clearing its remaining
prompt/session/handler typecheck errors (opencode total **389→311**). Also newly dispatched to fill
the raised concurrency: **P4** (fresh session, LSP/DAP/REPL + editor UX), **P3** (indexd + Core
context compile/selection/ledger/compaction; repo-tools/repo-intel/history explicitly carved out to
P7), and **P8** (RC0 1/5/10/20-session evidence composition + JC-RES-012.C–L negatives). **P5's own
scope is closed** after the AppRuntime fix and stays queued only for cross-phase follow-ups.

P3/P4/P8 remain partial (their unit gates pass but authenticated OS/Guarded acceptance is not done);
P9 is parent-owned. **License/notice decision remains deferred by the user, so public distribution is
not authorized.** Docs gates re-passed after the §42 edit: Markdown 0 blockers, convergence 1300/0.

**Cleanup done this wave:** removed generated `kernel/tmp-p8/` (11 MB, no live process) and the stale
`.gitignore` unignore for the deleted `worker_durable.rs` target; added exact unignores for 5 flagged
first-party/agent-added sources. Next parent actions: integrate the three owner reports, run the
combined cargo/typecheck/audits, then the free-model E2E smoke and integrated acceptance. V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.

**Parent P9 continuation (2026-10-23):** the public `horizoncode`/`hzcode` package bins now target
`bin/horizoncode`; the build emits `horizoncode-<target>/bin/horizoncode`, and release candidate
discovery, artifact audit, fixtures, Nix and Linux container entrypoint consume that name. The single
launcher implementation prefers `HORIZONCODE_BIN_PATH` and retains `OPENCODE_BIN_PATH` as compatibility
fallback; Nix/container keep `opencode` as a compatibility symlink, and the compiled user-agent names
`horizoncode/<version>`. Release-readiness tests pass **78/78**, py_compile, install
syntax and diff checks pass. Nix evaluation and a real candidate build/install are unverified; P9
remains PARTIAL. The complete first-party package/import/generated/build/typecheck/prose migration is
also now V1 under §17.7/§20.17/NAME-001..004; it is queued until P7 releases active typecheck inputs
and P6's remaining provider files are assigned/closed; `packages/opencode` still has private
`name: opencode`. See `reports/phases/P9.md` §8 and
`reports/release-readiness-2026-10-23-naming.txt`.

## Previous continuation checkpoint — 2026-10-22

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P7 streams/context/artifacts/analytics/automation/rewind. P8 handed off SOURCE-COMPLETE FOR CURRENTLY UNBLOCKED WORK, NOT PHASE-ACCEPTED, after adding a bounded repository-local task catalog and paired HostRun evaluator seam. P2 was immediately refilled for the complete managed phase: per-Task verification/DAG/aggregate settlement, authenticated CodeMode/root-artifact HostKernel routes, managed recovery, and Goal/Run delivery, while coordinating P1/P7 shared files. P1 has source for strict trusted Core→HostKernel workspace-profile projection, the shell-mode discriminator/digest correction, and a persisted-quiescence cgroup janitor. Janitor deletion requires a hidden cgroup hierarchy, persisted exact quiescence, exact root/cgroup owner plus device/inode/path revalidation, emptiness, and the exclusive namespace lock. The 256 bound remains only for quarantined UNKNOWN/Full Access/legacy/unproven groups; verified eligible groups are removed, so normal lifetime launches are not capped at 256. P1 still owes the complete fixed-argv profile effect/Guard/lease/receipt path and keeps terminal execution gated.

P7 source now routes V2 terminal admission and Bash execution through HostKernel with the exact lease, keeps the Bash leaf hidden until P1 readiness, and handles CodeMode's effect/host-callback split plus terminal pre-dispatch decisions. Root direct artifact lookup and wave-correlated cancellation still need P2's authenticated inspect/range and cancellation projections. P8 reports durable worktree/worker ownership and bounded resource reporting in source; it is implementing the local evaluation runner. OS hard CPU/memory/FD quotas remain unavailable where the backend cannot enforce them. Pressure-driven admission/eviction remains unavailable until trusted lower-watermark/calm-window settings and authenticated ingress are wired.

P6 is a partial handoff; P3/P4/P5/P9 and final integration remain open. Parent refills whole-phase slots as they open. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks have run per user instruction. Git is fully unstaged with mixed ownership; do not stage or publish until exact task-owned paths are separable. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Latest continuation checkpoint — 2026-10-22

Active whole-phase source owners: P1 Guard/ExecutionHost, P7 streams/context/artifacts/analytics/automation/rewind, and P8 worktrees/resources. P2 returned a partial source handoff: CodeMode contracts/helpers exist, but HostKernel prepare/settle/recovery handlers and managed Task verifier/scheduler integration remain; refill P2 when a slot opens. P6 also remains partial: provider transport/journal, offline Doctor, settings and S1 source exist; credentialed routes/live probes need P1 Guarded secret authority; P7 owns selectedRoute, atomic EventV2 usage settlement and UNKNOWN recovery. P7 owns those callsites plus nested CodeMode ToolBatch dispatch.

P2 has source progress on bounded multi-worker scheduling: `maxWorkers`, distinct child Locations, location-bound receipt basis. It is implementing per-Task verifier intents/evidence with aggregate Run verification retained at the final-revision boundary per DEC-V1-31. P1 compared local Codex/OpenCode cleanup patterns and found no crash-safe durable cgroup janitor; P1 is adding exact-identity, persisted-quiescence cleanup under exclusive locking. Missing proof retains/quarantines and fails closed.

Next whole-phase owners to refill as capacity opens: P3 RepoIntel, P4 LSP/DAP/REPL and command-only editor UX, P5 search/CodeMode, P8 worktrees/resources, P9 packaging/release. Parent still owns cross-phase integration and final acceptance. No checks/tests/builds/typechecks/provider calls have run, by user instruction. Git is mixed and unstaged. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

P1 safety refinement: because same-UID child processes may reach the delegated cgroup hierarchy, a flock is not enough to authorize janitor deletion. P1 is proving hierarchy isolation for every launch profile. Delete only with isolation plus persisted empty-state and exact device/inode/path/owner revalidation; otherwise retain/quarantine and fail closed.

P1 rejects sandbox roots overlapping `/sys/fs/cgroup` and is adding host-derived cgroup owner/isolation facts to persisted identities; legacy or unproven identity is retain-only. P2/P7 CodeMode nested waves must bind inside ordinary HostKernel ToolBatch admission before leases are projected; post-prepare bind would leak leases. HostKernel derives ordered receipt rows; caller-provided effect/receipt IDs are not authority.

Command profile request shape is resolved: one canonical `terminal.run` capability with a strict profile-mode variant (trusted profile/action refs plus bounded configured args) and a separate shell-mode variant. HostKernel resolves the immutable profile and constructs fixed argv; never pass shell text for profile execution. Stale “awaiting shape decision” tracker text is superseded.

Cross-phase contract decisions: CodeMode supports mixed read/control/effect waves. Rust derives `effect_receipt` only from the exact settled EffectHost receipt, `host_decision` for durable pre-dispatch denial/cancellation, and `tool_result` for Core-reported terminal ordinary read/control output. `tool_result` binds the bounded redacted output digest/byte count, and is not effect authorization or independent verification evidence. UNKNOWN is receiptless and stops later waves. P1 owns retained call identity projection; P2 owns Rust persistence/API/schema; P7 owns the TS protocol and adapter. For workspace profiles, P1 privately projects the selected immutable Core Config definition and exact grant tuple to HostKernel; §37.27 needs no global Config revision counter. HostKernel recomputes the digest and revalidates profile/executable/workspace/policy/backend pins before spawn.

P1 source audit found the V2 direct shell route is still absent: `tool/bash.ts` fails closed, and `session/runner/llm.ts` admits only a single `files.write` lease; legacy ShellTool→Pty is not evidence for V2. P7 owns the `runner/llm.ts` caller; P1 owns terminal.run Guard/HostKernel/EffectHost/ExecutionHost APIs. Do not enable shell until Core uses that API and settlement/recovery is integrated.

CodeMode digest authority is now versioned in v2: separate wave/run domains bind ordered canonical tuples `[waveIndex,callIndex,callId,status,receiptKind,receiptRef,receiptDigest]`. The private EffectHost settlement hash remains distinct and never leaves Rust; UNKNOWN has no aggregate digest. This supersedes the old v1 public tuple text in §§12.21/37.24 and must be reflected in schema/fixtures before integration.

Deterministic pre-dispatch CodeMode denial/cancellation produces ordered Rust/EffectHost `host_decision` receipts and skips all Core callbacks; Core must not attempt callback settlement on denied calls. If dispatch may have begun, reconcile as UNKNOWN.

P1's shell variant keeps existing command/cwd/timeout semantics plus host-resolved shell profile/environment; the profile variant has action/profile revision/digest and bounded configured arguments only. For CodeMode, P7 runs nested calls through `SessionTools.resolve` and passes exact prepared calls plus the retained helper frame to P2's HostKernel admission; P2 must exact-match, use the ordinary Guard/lease path, and bind durably before returning leases.

P7 has source-wired trusted selected-route projection and atomic EventV2 provider settlement, with restart DISPATCHING recovery to UNKNOWN and no replay. Context-ledger publication now occurs before dispatch. CodeMode ToolBatch adapter is still being integrated against P2's final receipt DTO. No checks run.

## 2026-10-22 — current active owners

P1/P2/P6 are the only active whole-phase implementation owners (three child
slots total). P1 found no EffectHost consumer for authenticated bounded
`commandProfiles`; it owns the consumer and an effect-bound workspace revision
in terminal artifact receipts. P2 owns authenticated HostKernel session/profile
selection, root batch-journal replay correctness, and the read-only root artifact
projection. P6 owns the protected direct provider dispatch bridge using Auth's
existing pinned direct fetch; credentials must be resolved/injected only inside
Auth. A command-profile request-shape decision is pending user input: reuse
canonical `terminal.run` with trusted action/profile refs (recommended), or add
`workspace.command`; keep that wiring paused. P7 is queued for the next freed
slot. No verification commands have run under the implementation-first hold.
P6 has source for Core→Auth direct provider dispatch using the existing pinned
request fetch and durable SessionStore journal; the new LLM route implementation
files were initially hidden by `.gitignore` and need narrow Git exceptions
before integration. Credentials remain private to Auth; credentialed routes
remain unavailable.
Root and dependency-ready Task derivation are source-present; the managed
scheduler still limits each Run to one active Attempt for a shared mutable
workspace. DEC-V1-31 requires bounded multi-Task DAG execution after the single-
Task vertical, so this remains incomplete. P8 has per-candidate durable
reservation/resolution APIs and HostKernel child-Location projection; P2 must
compose those for ready siblings and implement multi-active reducer admission,
per-Task verification and aggregate settlement. Prior tracker text saying root
readiness is missing is stale.
P2 has source-wired authenticated `execution.v1/direct_session_artifacts` and
typed `SessionSupervisor.listDirectSessionArtifacts`, deriving ordered calls
from the HostKernel batch index and validating EffectHost receipts plus
ArtifactStore metadata/bytes. It remains source-only; artifact search and
consumer integration are not yet complete.
P3-P5/P7-P9 and final integration/verification remain unfinished. Do not claim
release; preserve the mixed Git tree.

## 2026-10-22 — direct CodeMode recovery update

P1 has source for direct-root CodeMode terminal receipt recovery in EffectHost:
it validates trusted direct-session authority, exact committed wave frame and
digest, direct scope, and ordered calls against durable `session_batch` rows,
then projects immutable per-call receipt refs/kinds/digests. The old statement
that this EffectHost query is still missing is superseded. The runtime remains
closed: P1 also added a DB-derived wave-pin resolver, so P2 can recover the
committed authority and wave pins without request-supplied pins. P2 must wire
the authenticated HostKernel lifecycle and expose the typed Core Supervisor
projection; P7 then consumes it through ordinary ToolBatch. P1 also added the
ExternalEditor cgroup identity to its durable binding; P2 must pass it through
and prove cgroup quiescence during recovery. No tests/builds/typechecks ran.
V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

The §37.24 start contract intentionally carries no Core-supplied lease:
HostKernel derives current location/lane and prepares/checks the outer
`codemode.execute` effect/lease from authenticated Session/Attempt state. Core
supplies only trusted lane binding, request ID, enablement ref and bounded
start frame. Missing authenticated Session→Location mapping remains fail-closed.
P7's caller seam keeps `codemode.execute` on the ordinary Tool.Def: trusted
Tool.Context carries sessionID/callID/lane/abort; callID is private
Supervisor correlation only. HostKernel matches the active Guarded call and
derives its own challenge/lease, binding a fresh host requestID before spawn.
No caller-supplied lease or new public RPC fields.

P1 has added persisted terminal cgroup binding and startup UNKNOWN/quiescence
reconciliation APIs for interactive `terminal.run`/`terminal.start`; P2 has
source-wired HostKernel with exact Guard lease, principal, Attempt/profile/
owner-epoch pins and kill-and-empty proof before settlement. The route remains
gated by `GUARDED_PTY_RUNTIME_READY=false` pending acceptance. P1 also
added strict CodeMode execution inspect over durable process receipts, while
P2 still owes authenticated start/resume/wave/cancel and typed Core lifecycle.
Inspect alone does not enable execution. P1 removed the stale anonymous Tavily
route; four fixed keyless routes remain with BYO Tavily separately enabled.
P1's effect-origin audit confirms current plugin/MCP/hook/legacy process paths
are closed before dispatch: only pinned HostKernel/session-supervisor
processes may launch; plugin hooks are inert; MCP connections/tools/prompts/
resources are unavailable; project tools are absent from the first-party
registry. P2/P4 still owe typed host routes and integrated acceptance.

P7 source audit: ActivityStream projection, sequence/generation fencing and
resnapshot, ContextLedger UI projection, and token/cost provenance analytics
are present in source but unverified. P1 provides
`list_direct_attempt_terminal_artifact_receipts`; P2 has source-wired the
direct artifact list plus authenticated Core inspect/range and EffectHost /
ArtifactStore receipt checks. P7 integrated the route for direct child Attempts
through `SessionTools` scope, artifact search and opaque shell ref hints for
non-sensitive FULL/SAMPLE captures. Root sessions have no DirectAttempt scope,
so root artifact search remains unavailable. Source only; caller paths/refs are
never authority.

Artifact lookup decision: P2 uses P1's trusted terminal-receipt enumerator and
can reuse the existing deterministic
`terminal_<blake3(effectID)>` ArtifactStore key after deriving effectID through
the authenticated current direct Session → committed ToolBatch → settled
receipt chain, then verifying stored owner refs, workspace revision,
DirectAttempt/effect IDs and terminal receipt digest. Do not add a duplicate
index/database or accept an artifact ID/path from the caller.

P7 now writes the same canonical Core `providerRequestID` into
`SessionEvent.Step.Ended.usageProvenance.requestID`, matching ContextSelection
and the future P6 provider journal. P6 still needs to preserve it as non-wire
RequestExecutor metadata; no provider dispatch is enabled.

P7 has added exact source byte counts (`bytesKind: exact`) to direct
ContextLedger Session-message/profile entries where encoding is known. The
aggregate provider-input source leaves bytes unknown because `ledger.requestBytes`
already reports the aggregate; token counts remain unknown without tokenizer
estimation. P7 also reports that Core currently
exposes direct wave receipt lookup only; P2 still needs to provide typed
start/resume/prepare-wave/settle lifecycle calls before P7 can enable nested
CodeMode.

P7 also fixed a provenance race: direct ContextLedger now binds the
`sourceRevision` captured with the frozen request context. A later Session
event cannot leak into that ledger; cursor lookup failure only suppresses the
UI projection.
The TUI summary labels exact request payload bytes separately from unknown
token totals and shows refs/protection counts/cache classes.
Source review caught and fixed an unbound ContextLedger `sourceRevision`
identifier by consistently using `input.sourceRevision`; this remains
unverified because checks are still deferred.

## Current integration checkpoint — 2026-10-22

P2 has source for managed effect-wave receipt lookup through authenticated
HostKernel/Core. For known terminal outcomes it projects durable `challengeID`
as the exact CodeMode `receiptRef` plus a terminal digest; pending outcomes are
rejected, and UNKNOWN exposes neither public receipt field. Direct-root
CodeMode still needs the equivalent P1 EffectHost query and P2 authenticated
HostKernel caller, bound to the live Session/owner epoch/policy/workspace and
committed ToolBatch. P7 owns the Core consumer; both lanes remain disabled.

P7 also found that the ContextLedger observer ID differed from the ID
needed by the durable provider request journal. P7 now mints one stable request
ID on `LLMRequest.id` at request construction; P6 must preserve it as non-wire
metadata through the protected
RequestExecutor edge. The ID survives `LLMRequest` compile/prepare/stream, but
`HttpTransport` currently drops it at `RequestExecutor.execute`; pass it as
non-wire executor metadata, not an HTTP header. Provider dispatch stays closed
until exact pins and atomic assistant/usage/journal settlement are connected.
No validation ran.

## 2026-10-22 continuation

P7 has now added the Core nested-wave dispatcher seam to `Tool.Context` and the
canonical direct `SessionRunner`: bounded whole-wave validation, ordinary
ToolBatch admission, lease validation, and sequential `materialization.settle`
are connected. The callback is intentionally nonrecursive and does not invent
the §37.24 per-call receipt projection. P5 still needs to register its strict
CodeMode adapter in Core; P2/P1 must supply authenticated receipt refs/digests
from durable HostKernel settlement. CodeMode remains disabled. Implementation
only; no checks have run.

Live whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel,
and P7 streaming/context/artifacts/automation/rewind. P4 returned PARTIAL after
passing the Explorer preview's exact `contentDigest` to the editor callback.
P6/P8/P9 remain unfinished; the platform thread limit currently prevents another
owner from starting. Workspace editor contract now requires private HostKernel
scratch, editor argv containing only its scratch path, exact original preview
revision/digest binding, and a separate Guarded `files.patch` after successful
close and current-revision recheck. P2 keeps workspace launch closed until P1's
durable binding lands. P1's EffectHost query now recovers exact per-effect
Attempt process and ToolBatch receipts from durable rows; editor scratch binding
is still in progress. P7 owns direct Core `SessionRunner → LLMClient.stream`
integration; P6 must provide the selected-route Core RequestExecutor adapter.
No validation/provider calls until implementation closes. V1 remains PARTIAL /
NOT VERIFIED / NOT RELEASED.

**CodeMode direct-lane gap:** The OpenCode-derived CodeMode adapter is not
registered in Core's direct `ToolRegistry`. P7 is adding the runner-owned nested
ToolBatch admission/settlement callback; P5 must add a Core registry adapter
that consumes it when a phase slot opens. Keep CodeMode disabled until that
bridge and the P1/P2 helper/Guard requirements are integrated.
Core also lacks authenticated per-call nested-wave receipt refs/digests: P2 must
project exact durable receipt evidence from P1/Rust; tool output cannot fabricate
the §37.24 receipt fields.

**P2/P8 recovery seam:** P8's cross-epoch settlement proof currently requires
the terminal child-prompt quiescence marker to match the resumed owner epoch,
but the existing Attempt snapshot can carry only the original immutable marker.
P2 owns the HostKernel seam: after restart, re-observe the terminal child
Session's prompt/request/provider-task quiescence and all effect/process refs
under the current authenticated owner epoch, persist a fresh epoch-bound proof,
and preserve the original verified workspace head. Never relabel the old proof;
keep recovery unavailable on any live or UNKNOWN effect. P8 must consume this
route when a whole-phase slot opens.

P2 source has added `ManagedAttemptCurrentEpochRecoveryQuiescenceV1`, distinct
from the immutable terminal marker, with current process/session observation pins
and the original terminal/effect/evidence/workspace-head digests. HostKernel
minting remains incomplete pending live child-session re-observation and P1's
exact per-effect scope/receipt recovery API. P1 now exposes recovery pins as
`ManagedStdioEffectRecoveryPinV1 { effect_id, attempt_scope_digest }` and returns
`recover_managed_attempt_effect_receipts(principal, session_id, pins)` with exact
ordered batch/call/effect/attempt-scope pins and immutable lease/status/receipt
rows. P2 will persist each post-bind attempt-scope digest on the wave edge and
use this query for both current-epoch recovery and CodeMode wave receipts.

**Direct-provider callsite correction:** The normal direct coding path is Core `SessionRunner` → `LLMClient.stream` (`packages/core/src/session/runner/llm.ts`), not only OpenCode-derived `packages/opencode/src/session/llm.ts`. The reusable transport boundary is the existing `@opencode-ai/llm/route` `RequestExecutor.Service.execute(HttpClientRequest)` dependency in `packages/core/src/effect/app-node-platform.ts`. P7 owns exposing the frozen provider-native request plus exact Profile/ContextSelection pins to that layer; P6 owns selected-route/SecretBroker transport there. SessionStore's direct request journal, atomic assistant/usage settlement callback, and transport adapter still need production wiring. Provider sends stay fail-closed until selected route, profile/effective-scope/context pins, non-secret executor request digest, and atomic settlement are consumed together. P7 has now added best-effort direct ContextLedger source projection from Core `SessionRunner` when an explicit matching main AgentProfileV2 and built-in HarnessProfile are configured; this is UI-only, asynchronous and does not authorize or gate sends. Direct selection and ledger request/journal integration remain unfinished.

**P7 continuation (2026-10-22; implementation only):** The direct ContextLedger projection now includes the immutable provider-native prepared body (without auth/headers), canonical provider-input digest, current source revision, explicit matching primary AgentProfileV2 and built-in HarnessProfile references, BLAKE3 message-source digests, and an ephemeral per-request ID. It publishes asynchronously as a bounded UI observer; the event cannot authorize, block, or claim provider dispatch. SessionStore already exposes PINNED/DISPATCHING/SETTLED/UNKNOWN journal operations, but the normal direct caller still lacks complete trusted route/effective-scope pins and P6's RequestExecutor adapter, so sends remain fail-closed. Direct TUI ContextLedger updates accept a new request ID within the same source revision/generation while enforcing nondecreasing timestamps; managed sequence fencing remains unchanged. Legacy snapshot-based file rewind in Core now returns unavailable from stage/clear whenever files would be restored: §15.15 requires a revision-bound preview/conflict review, and only the new HostKernel preview route exists; there is no accepted restore dispatcher or receipt yet. Automation invocation, direct ArtifactStore search, checkpoint restore, and full ContextSelection persistence remain gated. No tests, builds, typechecks, audits, or provider calls were run.

**2026-10-22 — active whole-phase owner checkpoint:** P2 managed lifecycle/HostKernel, P4 LSP/DAP/REPL/external editor, and P7 streaming/context/artifacts/analytics/automation/rewind are active. P1 returned PARTIAL after its unblocked source pass and remains responsible for integration/acceptance. P3 and P5 handed off their unblocked Explorer and search/CodeMode source; search and CodeMode remain gated pending P1/P2/P7. P6, P8, P9 and final V1 acceptance remain open. No tests/builds/typechecks/audits/provider probes before implementation closes, per user direction. Mixed Git state preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — current live roster correction:** P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P4 LSP/DAP/REPL/external editor are active whole-phase owners. P3 handed off unblocked authenticated Explorer/discovery and exact-revision preview source. P5 handed off unblocked search cascade receipt/retry and authorized CodeMode catalog/strict adapter source; both remain unavailable pending P1/P2/P7. P7 is next to resume when a slot opens. No checks/provider calls run before implementation closes, per user direction. Mixed unstaged/untracked work is preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — live source-only owner correction:** Active whole-phase owners are P1 Guard/ExecutionHost (resumed), P4 LSP/DAP/REPL/external editor, and P5 web search/CodeMode. P3 handed off its currently unblocked source: authenticated bounded HostKernel discovery/read routes, SDK projections and revision-bound `/editor` tree/file previews; exact ignore exceptions expose new source to Git. P4 removed ambient LSP filesystem marker probing and added strict editor-profile schema/config; global-only profile CAS/settings and gated launch adapter are underway. P5 fixed explicit-null zero-send receipt parsing, projected bounded authorized CodeMode definitions (including deferred candidates) through `SessionTools.resolve` and `LLM.StreamInput`, and added a strict adapter over the existing authenticated `requestHostKernel` callback for the five §37.24 operation names. Rust handlers are not routed and P7's ordinary ToolBatch wave callback is absent; CodeMode and live search remain unavailable. P2/P7 remain next whole-phase owners when slots open. No checks/provider probes run, as requested. Preserve mixed unstaged/untracked state. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — current owner refill after quota exhaustion:** P1/P2/P7 agents terminated on their execution usage limit; their latest messages are source-only partials. Active whole-phase owners are P3 RepoIntel/Explorer, P4 LSP/DAP/REPL/editor, and P5 search/CodeMode. P3 owns the authenticated bounded read-only Explorer endpoint, SDK and `/editor` overlay. P4 owns configurable external-editor launch and supervised protocol source. P5 fixed parsing of explicit-null `NOT_DISPATCHED` receipts; one same-route retry is allowed only on durable zero-send proof, with post-send ambiguity UNKNOWN. P2's partial global primary-profile selector and P1's persisted/replayable exact HTTP/Git-read results still require production callers. Parent added the `Session.updateMessage` EventV2 transaction commit-callback seam; direct provider dispatch remains fail-closed until P2's exact AgentProfileV2 authority reaches LLM and the stream settles assistant projection, usage and request journal in one transaction. No checks were run. Git remains mixed/unstaged; do not stage or publish ambiguous work. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — current parent integration decision:** The actual active whole-phase owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P7 streams/context/artifacts/analytics/automation/rewind. P6 handed off PARTIAL after completing currently unblocked source work; P1/P2/P6 remain responsible for their phase defects when integration dependencies arrive. P7 now owns the direct frozen ContextSelection/provider payload caller and nested ToolBatch adapter. The Git-read gap is assigned: P1 owns Guard/EffectHost approval/grant authority and durable exact-result receipt/replay; P2 owns the authenticated HostKernel RPC/Core caller. Use the existing bounded workspace `files.read` grant without per-read prompts after preauthorization; otherwise use the standard Guard approval challenge. A possible-send ambiguity remains `UNKNOWN`, and a digest-only receipt cannot be replayed as output. CodeMode and editor effects stay unavailable pending integrated acceptance. No checks/provider probes ran; mixed unstaged/untracked work is preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — latest V1 continuation:** Current active whole-phase owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P6 providers/settings/Doctor/S1. The platform supports four agents total including the parent; queued phases must be assigned as real slots free. Parent has added a stdio-only CodeMode helper entrypoint and Linux GNU build packaging output plus a `sha256:` manifest, matching fixed selector `horizoncode:codemode:bun` and the Rust helper asset bound. P6's Core adapter securely installs the embedded asset/manifest in owner-only `Global.Path.bin/codemode-helper`, writes the manifest last and passes only `--codemode-helper-root=<root>` at HostKernel startup; P2 is adding strict HostKernel parsing and trusted selector resolution. This is packaging source only: shared Guarded ToolBatch wave dispatch, durable receipts/recovery, cancellation and registry exposure remain unintegrated; keep CodeMode unavailable. `/editor` is user-invoked and single-pane by default, but its Explorer currently has no tree rows; P3/P4 source integration remains open.

P1's new process-scope API has `Session { session_id }` and `ProjectRead { workspace_id }`; P1 owns `managed_verifier.rs` Session binding and P2 owns the corresponding HostKernel constructor integration. Project VCS reads use HostKernel-authenticated principal and Location/workspace identity plus the existing explicit `workspace-code/read` grant; do not synthesize a Session or bypass Guard/lease/receipt. P6's direct provider transport now prepares and pins the exact selected anonymous-free route; P7 must consume the typed API with frozen request/context pins. No checks or provider probes have run under the user's source-first hold. Mixed Git state remains unstaged and preserved; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — live search/CodeMode integration update:** P1 has source for the trusted pre-send HTTP proof, whole-MCP-handshake executor and no-response aggregate settlement, including terminal CANCELLED/FAILED/EXHAUSTED with exact ordered receipts and no fabricated response. P2 added nullable `notDispatchedFailure` to ordinary and restart receipt projections and still owns production HostKernel dispatch/recovery integration. P5 source validates retry reason with durable receipt and zero response/body metadata, allowing one retry only for `timed_out`/`transport_failure`; it handles aggregate `CANCELLED` and reserves top-level `NOT_DISPATCHED` for pre-plan rejection. Parent/P2 ruling: `FAILED` represents a known terminal 4xx outside {401,403,407,408,425,429}, with plan digest and exact settled history; `EXHAUSTED` means all explicit routes/retries were consumed. P5 removed arbitrary CodeMode callback construction; CodeMode stays unavailable until a private ordinary ToolBatch binding is connected to authenticated Rust/P2 settlement. Current whole-phase owners: P1, P2 and P5. P3/P7 are PARTIAL; P4/P6/P8/P9 remain open. No verification has run. Git state remains mixed and preserved; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — active source checkpoint:** Whole-phase owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P5 web search/CodeMode. P3 and P7 have returned PARTIAL after their unblocked source passes and must resume for dependencies/acceptance. A non-overlapping P2 UI worker confirmed Goal proposal, reviewer inbox, start, and Run controls are wired; it added an unrun cancellation regression and corrected the pause fixture. P1 source now binds the managed verifier challenge to an assessed launch profile before approval and adds a durable HTTP `NOT_DISPATCHED` receipt from a host-minted zero-send proof; only timeout/transport pre-send proof can retry once, while cancellation is recorded without retry and any possible-send ambiguity stays UNKNOWN. P3's history reader now size-checks stored Part rows before JSON decoding and validates the row again before bounded range return. P7's managed ContextSelection producer includes `lane: managed`; its ContextLedger event/TUI projection is bounded, identity-fenced, ephemeral, and does not gate provider dispatch. No tests/builds/typechecks/audits/providers ran. Preserve mixed unstaged/untracked Git state. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — P1 verifier Guard update:** EffectHost verifier preflight now requires nonempty Session, live Attempt scope digest, and a verifier principal distinct from the authenticated reviewer; fixtures were aligned to current HostKernel invocation pins. Source only, no checks. P1 continues full Guard/ExecutionHost closure.

**2026-10-22 — profile-bound ContextSelection:** P3 now requires explicit lane and exactly one direct Core Config AgentProfileV2 ref (ID/revision/digest/trust) in ContextSelection; callers must provide authenticated profile identity and cannot infer it from names/models. Managed ContextSelection likewise must carry lane=managed and the Task-pinned profile. P2 owns direct Session callers, packages/opencode/src/session/prompt.ts, and managed-control persisted/recovery constructors. Ledger capture remains gated until those exact pins arrive. No tests ran.

**2026-10-22 — phase owner refill:** Active whole-phase owners are P1 Guard/ExecutionHost, P3 RepoIntel, P7 streaming/context/artifacts. P5 returned PARTIAL; its unblocked source is present and remaining NOT_DISPATCHED transport/receipt, direct-root BYO scope and CodeMode bridge depend on P1/P2/P6/P7. P2 is next critical-path refill. P3 aligned ContextLedger TypeScript/JSON Schema/§30.2, added explicit ContextSelection.lane, and requires a trusted Core Config AgentProfileV2 reference in direct selections. P2 handoff is exact: resolve/pass `{profileID, revision, profileDigest, trust}` at every direct `V2Session.contextSelection` caller; update `compileManagedContextSelection` in `packages/opencode/src/session/llm.ts` to set `lane: "managed"`; and update/compare persisted selection creation and recovery through `packages/opencode/src/session/prompt.ts` (initial sequence-1 path near `compileManagedContextSelection`, follow-up path near its second call, and `horizonManagedPreflightV1` replay) plus strict managed-control selection decoders. `llm.ts` is P7-owned, so P2 must coordinate that one-line producer change with P7. Direct ContextSelection currently lacks an active profile resolver/caller; direct ContextLedger capture stays unavailable until the exact selection is present. Parent added ephemeral `session.context_ledger` event design plus CTX-001..005; P7 owns event/UI integration. P1 verified the Rust zero-tool CodeMode pure-compute start path already accepts an empty tool list. No checks ran; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — whole-phase continuation:** Current actual owners are P1 Guard/ExecutionHost, P3 RepoIntel, and P7 streams/context/artifacts. P5 returned PARTIAL after unblocked source completion; its remaining retry/transport/HostKernel BYO and CodeMode RPC integrations depend on P1/P2/P6/P7. P2 is next critical-path refill when a slot opens; P4/P6/P8/P9 remain in scope. P3 and P7 are coordinating ContextLedger contract versus frozen provider-payload capture. Direct-root anonymous search already exists; direct-root BYO search lacks a trusted profile-scope source. Retry is limited to one same-route retry when transport proves no request bytes left the process; possible-send ambiguity remains UNKNOWN. No tests/builds/typechecks/providers/release checks ran. Preserve the mixed Git tree and existing user changes. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P3 has landed a pure `compileContextLedgerV2` compiler keyed to exact request/ContextSelection pins; P7 will capture the frozen provider payload at `transformParams`, omit raw payload persistence, and preserve unknown token evidence. The ContextLedger TypeScript, §30.2 example and JSON Schema mirror are reconciled. Direct capture remains fail-closed until Core supplies the exact trusted profile-pinned selection. P7 also removed arbitrary callback injection and added bounded actual SVG/Mermaid concurrency plus stale-generation retry. P5's remaining sources are blocked on P1/P2/P6; a partial handoff is requested to free a child slot for P1/P2. No checks ran.

**2026-10-22 08:18 UTC — direct-session grant correlation:** P1 has added the read-only EffectHost root-session protocol grant candidate lookup; P2 has added HostKernel preflight plus the optional `grantPreflightDigest` resolution contract. Parent P4 now sends the exact validated singleton challenge digest only on preflight-eligible auto-resolution. If resolution returns typed `effect_conflict`, Core opens the ordinary approval prompt and retries without the preflight marker; explicit user approval is never inferred from the stale candidate. P2 is checking that conflict mapping and challenge lifecycle match this fallback. Source only, no validation run per user direction. P1/P2/P5 occupy all three child slots. No effectful editor route is enabled; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 08:13 UTC — live owner/dependency checkpoint:** Whole-phase owners P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P5 search/CodeMode occupy the three available child slots. P1 reports source for root-session read-only LSP/DAP grant authority and durable `EMPTY` route outcomes; P2 reports HostKernel `EMPTY` and explicit-empty-domain `NOT_DISPATCHED`; P5 closes the false CodeMode gate before interpreter/catalog access. No acceptance has run. Parent P4 adapter changes allow no-Attempt root Session scopes in LSP/DAP/REPL Core validators and require current HostKernel epoch at protocol authorization, but the production prompt callsite still binds editor lifecycles only to child/managed Attempts. It lacks a trusted root workspace-revision projection and root grant candidate flow. Keep all effectful routes unavailable until P1/P2 provide and integrate live HostKernel workspace/process revalidation, grants, one-use lease/receipt and recovery. No tests/builds/typechecks/audits/providers ran. Git remains mixed/unstaged; one primary worktree; 814 GB repo filesystem free; `kernel/target` 627 MB. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 07:52 UTC — phase refill:** P3 completed its unblocked RepoIntel source pass and is PARTIAL pending P1/P2 integration, parser-backed navigation/overlays/cache, and final acceptance. The RepoDocumentRead DTO/callers now require `revisionKind`, use `discovery_observation` for RepoDetect and `workspace` for LSP/structure reads, and reject mode mismatch; lexical declaration candidates are bounded and labeled PARTIAL. Its slot is now assigned to the whole P5 search/CodeMode phase. Active owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, P5 web search/CodeMode. P2’s HostKernel read path uses strict revision-domain decoding, no-follow descriptor-relative file opening and pre/post observation. P1/P2 agree on CodeMode wave ownership; P5 owns Core interpreter/registry/search integration, P7 will own provider-payload/tool-batch callsites. CodeMode/search remain gated. P4 source audit found false LSP/DAP gates, no production DAP route, and REPL still lacks accepted hard quotas/Guard routing. No checks/provider calls ran; repo disk remains ample (last check 813 GB free, target 627 MB); mixed Git state preserved with no mutation. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 07:44 UTC — architecture freeze / implementation roster:** Exhaustive line-by-line review covered all `arch_V1/*.md` files and current changed sections; Codemode execution/worker schemas and their §12.21/§37.24 contracts were cross-checked. Web references reviewed: official Cloudflare Code Mode, OpenCode V2 permission docs, OpenAI Codex sandbox and multi-agent docs. Core decisions: CodeMode composes existing authorized tools, nested effects use existing Guard/leases/receipts, and direct/managed enablement remain separate. Direct-session routine grants provide a low-friction path; required unsupported OS guarantees remain unavailable regardless of approval. Artifact wire values are `full|head_tail_sample|failed`; UI labels are FULL/SAMPLE/FAILED; direct refs cannot enter managed evidence. Event envelope cursor is not SSE replay authority. CodeMode protocol requires ordered call/result matching, per-call receipts, explicit UNKNOWN, 2 MiB frame/1 MiB tool-definition and argument caps with the existing Rust frame codec as sole canonical validator. These are design contracts, not source acceptance. Active whole-phase owners: P1 `/root/p1_guardv1`, P2 `/root/p2_managedv1`, P3 `/root/p3_codingrepo`; P4–P9 are queued and will start as slots free. User deferred tests/builds/typechecks until source work is complete; none run. Preserve mixed Git changes; no stage/commit/push or cleanup. Last disk reading: 813 GB free, shared `kernel/target` 627 MB; one primary worktree.

**2026-10-22 current continuation:** The full line-by-line `arch_V1` review and web research are complete. The grant flow now has an exact preflight DTO/schema and digest; P1's Core caller and P2's HostKernel read-only preflight agree, and atomic approval resolution remains authoritative. Current whole-phase owners are P2 managed lifecycle/DAG and HostKernel, P5 search/CodeMode, and P7 stream/render/artifact/analytics/automation/rewind. P1's direct-grant implementation task ended after its current source pass, but P1 as a full phase remains PARTIAL and awaits the next slot. P7 repaired the isolated ContextSelection compiler; P2 added the Core service API, but the actual model prompt path has no callsite. P7 owns LLM/tool-batch integration of the same frozen provider payload. P2 also must bind terminal build/test to immutable user-owned command profiles; generic `terminal.run` cannot receive quiet grants. P6 unblocked source pass is complete. CodeMode, search/provider dispatch, raw ripgrep, automation and other dependent effects remain gated until documented prerequisites pass. No tests/builds/typechecks/audits have run under the user's implementation-first hold. Preserve mixed Git state (no staged changes; `main` ahead 13 of `origin/main`) and the one main worktree.

**2026-10-22 06:42 UTC — architecture freeze checkpoint:** Full line-by-line arch_V1 audit completed across §§01–45, including compatibility stubs and all 3,099 lines of §37. Updated contracts for CodeMode, low-friction exact grants and trusted command profiles, managed DAG as a V1 requirement after the single-Task prerequisite, context/provider/search source truth and analytics/source status. Added `WorkspaceCommandProfileV1` schema and GRANT-011..016. Current gaps: CodeMode is not integrated; direct grant quiet path is file-write/patch only; build/test profiles and Guard matching remain design; search/provider runtime gates remain unavailable; full model-aware context compiler is unfinished; managed multi-Task DAG remains gated; direct ripgrep stays false-gated until HostKernel Guarded read path exists. P1, P2 and P5 are active whole-phase implementation owners with non-overlapping ownership; P2/P1 coordinate Rust HostKernel seams and P1/P5 coordinate CodeMode. User deferred tests/builds/typechecks until implementation closes; none run. No Git stage/commit/push/cleanup; mixed tree preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 16:05 UTC — current owner checkpoint:** P1's latest source update separates stable Stage-A candidate `proofDigest`, stable Stage-B `receiptDigest`, and fresh current `leaseProofDigest`; HostKernel §37 and the pre-admission wire contract now agree with P2's strict decoder. P2 validates that Stage B preserves Stage-A identity and publishes the persisted ContextSelection `sourceRevision` on replay. P8's staged lease is source-complete; remaining HUP/RC0/resource paths are dependency-blocked and unavailable. P1 resumed source work in lower-level ExecutionHost/transport files while P2 owns managed HostKernel inbox/wake files. P7 is active on the full streaming/render/artifact/analytics/automation/rewind phase, including transformed-payload binding. Managed provider dispatch remains disabled pending trusted route resolution, SecretBroker lease consumption, and guarded ExecutionHost send/receipt lifecycle. No checks/builds/typechecks/provider calls/release operations ran; no Git mutation; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P7 now freezes the managed provider-transformed payload before authorization, hashes that exact message body, dispatches the same clone and skips a second transform. P2 found managed `agents.message` lacks Rust cursor/inbox/wake authority and has assumed exclusive ownership of the free HostKernel managed source to implement the architecture contract. This remains source-only; no acceptance was run.

**2026-10-21 15:59 UTC — live staged-admission checkpoint:** Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct lifecycle, and P8 worker/resource/recovery (three child slots occupied). HostKernel now has a source-present Stage-A reserve handler; Stage B and admission are being aligned to P8’s durable staged pins and immutable context-bind event. Core’s coordinator source performs Stage A, compiles the exact request without dispatch on the returned target, binds its ContextSelection, then admits while retaining the same prepared request. P1 now resolves existing Stage-A pins first, preserving their original expiry/root/resource/worktree identities. P8/P1 are separating the stable Stage-B bind receipt digest (retry identity) from the fresh cursor/pool-bound lease proof (current admission authority), because Attempt attachment advances the OwnerLog cursor. Stage-A replay must accurately indicate an already-bound reservation so Core can compare/replay the same context. P1/P8/P2 own this seam; P7 is queued for the next freed slot. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks/Git publication ran. No upstream fetch occurred. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 15:50 UTC — P6 managed provider projection:** P6 added
`Provider.managedRouteProjection` in `packages/opencode/src/provider/provider.ts` over the
existing Core provider registry and Auth SecretBroker metadata. It resolves the exact active
provider/model, allows only bundled first-party adapters and HTTPS or loopback HTTP, and derives
opaque routeID/endpointRevision values without returning a URL, headers, or credential bytes.
`credentialLeaseRef` carries the unique Auth SecretRef (not a one-use lease), or null only when
Core's exact anonymous-free model projection proves the selected OpenCode model is eligible.
Consent, Guard challenge and capability lease refs must come from trusted internal Guard
authority, never the request. P1 confirms Rust accepts the nullable DTO shape but prepare/begin
still return no-mutation UNAVAILABLE for all routes; independent HostKernel route/consent/Guard
resolution and guarded ExecutionHost transport are absent. No checks/provider calls ran; V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 12:56 UTC — P1/P3 phase update:** P1 source review found no additional safe Guard/ExecutionHost source gap: cgroup-v2 identity/restart UNKNOWN, ToolBatch bounds/receipts/cancellation, origin gates, and verifier-set receipt pins are source-present. Both synthetic runner fixture setups now reach their intended Rust denial cases but remain unrun. P1 still needs final integrated acceptance; its available slot is refilled with whole-phase P3 RepoIntel/Discovery. Active owners P2/P3/P7. P2 is completing verifier recovery/settlement and TUI Goal review source; P3 owns discovery/RepoIntel; P7 owns stream/artifact/automation/rewind. P5/P6/P8 source-complete for unblocked work, with their dependencies/acceptance open. No validation commands; repo-only boundary; preserve mixed Git.

**2026-10-21 12:54 UTC — P6/P7 handoff:** P6's currently unblocked source is present: offline Doctor, exact anonymous free OpenCode eligibility, settings/provider projections, and both owner-scoped question lanes. Credential writes, credentialed dispatch and live Doctor remain fail-closed pending P1 Guarded secret/network authority; FEAT-001..014 and S1 integrated acceptance remain open. P6 returned PARTIAL. Slot refilled to whole-phase P7 owner for SSE replay/generation fencing, activity stream rendering/redaction, artifact truth, analytics, automation and rewind. P1/P2 remain active. Implementation-first hold, repo-only boundary and mixed Git preservation remain.

**2026-10-21 12:52 UTC — P1 direct-turn source status:** Rust direct-turn journal/DTO, HostKernel begin/complete/fresh authorization, effect-scope binding, and Core caller are present; gates remain false. The old 91/2 session-runner failure note is superseded by historical 143/0 focused bundle evidence, but that is not final integrated-revision verification and nothing was rerun in this source-only session. P1 still owns the full Guard/cgroup/origin/ToolBatch recovery phase. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 12:51 UTC — verifier settlement source integration:** P1 now mints the private HostKernel `SettledVerifierChallengeSetPinsV1` only from exact persisted Verified ChallengeSet/evidence, passes it to P8, rejects client verifier pins for FAILED/CANCELLED, and compares the three verifier IDs/digests on durable receipt replay. P8's `WorkerSettlementProofV1`/OwnerLog v4 retains those pins for Verified settlement and forbids them for non-success quarantine; source is not verified. P2 is aligning the strict Core DTO to §33's canonical `builtin.verifier` Guard capability/action and the separate no-pin QUARANTINED shape. Active whole-phase owners: P1, P2, P6. P8 source-complete for unblocked work; P5 source projection complete but runtime gated. P6 now owns provider/auth/settings/Doctor/S1 source. No verification commands; repo-only boundary; mixed Git preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 12:49 UTC — phase-owner refill:** P8 completed its unblocked worker settlement source pass: verified settlements require P1's opaque HostKernel verifier-pin token; the durable OwnerLog receipt stores `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest` in schema v4 and includes them in the receipt digest. P1 still needs to mint/validate the token and compare receipts; P2/Core strict decoder remains in progress. P8 remains PARTIAL due trusted hysteresis inputs, safe cache retirement, unsupported hard OS quotas, RC0 attestation and fake-only HUP. Active whole-phase owners: P1, P2, P6. P6 now owns providers/settings/Doctor/S1 and SecretBroker transport; P5 remains source-complete but disabled pending P1/P6. P7 stream replay gap remains queued. No validation/provider/release/Git commands; repo-only boundary and implementation-first hold remain. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 12:38 UTC — active source implementation wave:** user selected optional Linux cgroup-v2 containment for P1 restart proof; backend and stdio ExecutionHost membership source already exist, so P1 is closing gaps rather than duplicating it. P1 owns full verifier ChallengeSet pins/recovery/receipt validation; P2 owns strict client decoding and settlement propagation. Settlement receipts must echo and validate `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`. P5's unblocked search schema/runtime provenance source is complete; runtime remains gated pending P1/P6 acceptance. P7 source audit found the SSE route lacks durable Last-Event-ID replay and sequence/generation fields; next P7 owner must wire canonical replay or consistently narrow V1 to resnapshot-only. Active owners are P1, P2 and P8 resources/workers/evaluation. No tests/builds/typechecks/audits/provider/release/Git actions; implementation-first hold remains. Mixed Git state is preserved. Repo-only boundary permits no outside path, service or remote. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 11:02 UTC — owner restart and source-review handoff:** Read the one specifically user-authorized pasted-text attachment. It restates full V1, local OpenCode/Codex implementation comparison, complete subagent lifecycle review, architecture/event-flow audit, implementation-before-tests, and immediate listed escalation for material decisions; it does not introduce a new contract. The pasted multi-agent transcript is a parent-orchestration/recovery example, separate from CodeMode. OMP MetaHarness contributes experiment/run/task/trace/resume patterns; HorizonCode already records the adaptation in §42.14 and the fake-only HUP runner. JCode QuickJS/swarm authority remains rejected as a second runtime/owner.








## 2026-10-21 11:15 UTC — P1 contract bounds; P2 checkpoint; P7 started

P1 added strict ToolBatch schema count/identifier bounds (32 calls/effectRefs, 256-byte protocol IDs) and HostProcessRef identifier parity. Its source audit found production effect origins either Guarded or denied before dispatch; no missing first-party production process origin was identified in packages/core/opencode source. It did not add a crash janitor: existing bwrap PID namespace/PDEATHSIG lacks durable exact containment identity, so PID/starttime/boot ID alone cannot safely authorize tree kill or prove quiescence; UNKNOWN remains. P1 is continuing the whole phase source audit and contract work. P2's direct follow-up runner source is in place, with its gate still false; P2 returned partial/unverified. Reassigned its freed slot to P7 streaming/rendering/artifacts/analytics/automation/rewind source implementation; P6 continues. P3/P4/P8/P9 remain partial source checkpoints; P5 remains dependency-gated. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. No files were staged. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:13 UTC — P2/P6 direct-source updates; release decisions pending

P2's server-callable serialized follow_up runner and authenticated HTTP delivery path are now source-present. It uses exact request/profile/live Attempt/completed-turn pins, prepare/commit receipts, HostKernel fresh-turn proof, exact message claim, persisted completion and idempotent consume ACK; ambiguity remains UNKNOWN and no duplicate prompt is injected. Runtime remains false-gated pending integrated P1/P8 acceptance. P6 source now narrows anonymous OpenCode eligibility to exact active, zero-priced, supported model refs shared by backend/default/picker; custom model loaders stay unavailable. TUI hydration and lane-specific reply/reject now cover both authenticated legacy and QuestionV2 streams. P6 is doing final source-only boundary review and local upstream comparison. No checks ran.

P9 release implementation remains partial. Two user decisions were requested asynchronously: distribution grant/notice review status, and whether V1 keeps remote install/update disabled until signing policy exists. Continue source work that does not depend on those answers. Active implementation owners remain P1/P2/P6; P1's restart containment source blocker remains unresolved. P5/P7 wait for agent capacity. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:13 UTC — P2 direct follow-up runner source added

P2 added the public follow_up HTTP delivery path using a live child Attempt/profile/completed-turn pin, bounded durable inbox reservation, HostKernel fresh-turn authorization, Guard prepare/commit, and a serialized internal SessionPrompt runner. It claims only the committed message, persists turn/completion receipts, and ACKs consumption; ambiguous delivering/UNKNOWN rows remain inspection-only and exact ACK replay is idempotent. `DIRECT_CHILD_TURN_RPC_ENABLED` remains false pending P1/P8 acceptance. No checks ran; P2 remains active for whole-phase managed lifecycle and integration. P1 resumed source implementation on the restart janitor and remaining protocol/origin closure; P6 continues providers/settings/Doctor/S1 and local-source comparison. No tests/builds/typechecks/audits/provider/release/Git operations ran.

## 2026-10-21 11:11 UTC — HostKernel restart boundary and child wake implementation

P1 source review found that unfinished stdio attempts recover to UNKNOWN, while live supervisor handles are process-local and cannot prove tree quiescence after HostKernel restart. Sandbox paths currently use bwrap PID namespaces, `--die-with-parent`, and PDEATHSIG; P1 is evaluating durable containment identity and restart reconciliation. Parent required identity-safe signaling and proof of the actual whole process tree; PID/starttime alone is insufficient, and any unclosed crash window stays UNKNOWN. No validation ran. P2 confirmed Goal proposal→accepted SpecVersion→review→`goal.start`, distinct HostKernel-assigned reviewer, final live workspace revision, and TUI decisions are source-wired; its remaining direct child `follow_up` HTTP edge lacks a reusable server-callable Core runner. P2 is implementing the runner and keeping the gate false. P6 confirmed distinct legacy and Core Question owners; QA-006 requires both event lanes to project only to their authenticated owner. P6 is handling the narrow source projection while provider/settings work continues. Active owners: P1/P2/P6. P3/P4/P8/P9 returned partial; P5/P7 await a free agent slot. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:09 UTC — P9 source checkpoint; P1/P2/P6 active

P9 returned PARTIAL after source-only release changes: clean-install scenarios now verify candidate/previous executable digests around each run and after the matrix; installer activation keeps recovery copies for both command names; release evidence fingerprints include `prepare_build.py`. Only installer/release-owned files changed. No release or validation commands ran. P9 is still blocked on distribution grant/notices, signing/update and rollback policy, final candidate and Linux/WSL acceptance. P1 has resumed full Guard/ExecutionHost source work; P2 continues managed/direct child and follow_up runner; P6 continues provider/settings/Doctor/S1. P3/P4 source checkpoints returned PARTIAL, P8 source checkpoint returned PARTIAL. P5/P7 remain queued, P0 integration parent-owned. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. Mixed unstaged/untracked Git state is preserved. Overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:08 UTC — P3/P4 source handoffs; P6/P9 owners refilled

P3 returned PARTIAL after source-only fixes for bounded directory enumeration, combined RepoIntel selector-count parity (100), profile provenance and fail-closed discovery adapters; parser provenance, trusted buffer snapshots, HostKernel read/cache contracts and P4 readiness remain dependencies. P4 returned PARTIAL after REPL's constant-false authorization gate, LSP/DAP cleanup/quarantine and authenticated P3 document reader wiring; production ingress, P1 Guard/confinement, DAP policy, OS-enforced REPL limits and real-project acceptance remain blocked. Both ran no checks. Reassigned the newly freed slots to whole-phase P6 Providers/Settings/Doctor/S1 and P9 Linux/WSL release source work; P2 remains active, P1/P8 returned source-only partial, P0 integration parent-owned. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:05 UTC — phase-owner refill and implementation-only checkpoint

P1 returned source-only/partial: HostKernel direct-turn completion and fresh authorization now call the full live Attempt-scope validator against the current revision. P1 acceptance remains open for durable process-tree quiescence, Guard/receipt recovery, origin closure, protocol integration, and adversarial recovery. P8 returned source-only/partial: fixed the evaluation artifact journal digest defect and added descriptor pinning, nonblocking exclusive lock, path/inode checks, and pre-dispatch size/identity fences; RC0/fan-out remain gated on P1/P2 and trusted OS resource limits. Neither phase ran checks.

P2 remains active and found/fixed same-Attempt/same-epoch inbox recovery: an idle child Session's persisted `delivering` row is now UNKNOWN, never reinjected; pending direct-turn completion replay is keyed by exact cycle/result digest and persists only the HostKernel receipt. P3 RepoIntel and P4 LSP/DAP/REPL whole-phase owners have now been dispatched in the newly available slots; P5/P6/P7/P9 remain queued for slots. P0 cross-phase integration remains parent-owned. All agents have the repo-only boundary and implementation-first hold; no tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. Git remains mixed and unstaged; preserve all changes. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

Actual current phase owners: P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, P8 resources/workers/worktrees/RC0/evaluation. Prior P2/P6/P7 runs terminated at usage limits and have been replaced where critical. P2 has the current §37.9 direct-turn HostKernel operation names/reply contracts from P1, all marked source-present/unverified. P3/P4/P5/P6/P7/P9 are queued for the next slots; parent owns shared trackers and final integration. Source-only work continues; no tests/builds/typechecks/audits/benchmarks/provider/release/Git operations. Mixed Git state is preserved; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**P9 owner update — 2026-10-21:** P9 remains PARTIAL. Release artifact outputs now use pinned repository-local directory descriptors, exclusive temporary files, and no-overwrite publication; candidate build markers are checked against the exact build root, source revision, and source digest. The isolated build-script patch uses a no-follow pinned parent and atomic replacement, and binary hashing rejects symlinks/non-regular files. Added unrun fixtures remain unverified. Linux and WSL candidate/install acceptance cannot run during the implementation-only hold; native Windows stays unavailable. Exact remaining product decisions/evidence are listed in `scripts/release/README.md`: distribution grant/notices; V1 package/artifact identity consistent with §18.16; signing trust root and update/channel/rollback policy; claimed Linux/WSL platform matrix; exact clean-candidate acceptance. No license, package publication identity, signing policy, or supported-platform claim was invented. No release commands, checks, or Git publication ran. Repository-only boundary remains active; mixed Git work is preserved. V1/P9: PARTIAL / NOT VERIFIED / NOT RELEASED.

**Owner refresh — 2026-10-21 06:30 UTC:** Active whole-phase owners are P2/P8/P9. P1 returned PARTIAL after manifest-pinned executable identity and supervisor source hardening plus unrun fixtures; §37.9 now specifies HostKernel-owned turn-cycle/FreshTurnAuthorization, but Rust journal/issuer/DirectTurnScope source and strict machine schemas are still absent, and abrupt owner-loss janitor proof remains unresolved. P2 resumed to implement the Core side only against P1's exact types and keeps `follow_up` unavailable until integration. P4/P6/P7 returned PARTIAL. P8 is adapting the local Oh My Pi MetaHarness experiment/run/task/trace, frozen config, paired task matrix and exact resume semantics into an offline fake-only runner; provenance is in §42.14, with no copied source or remote gateway/container paths. P9 resumed safe Linux/WSL release source; external legal/package/signing decisions and publication remain blocked by the repo-only boundary. SA-021 is added. No checks ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Owner refresh — 2026-10-21 06:29 UTC:** P1 returned PARTIAL after manifest-pinned executable identity hardening and an unrun spoof/replacement fixture. §37.9 specifies HostKernel-owned turn-cycle/FreshTurnAuthorization, but its Rust journal, issuer, DirectTurnScope integration and strict machine schema remain absent; janitor proof after abrupt owner loss remains UNKNOWN. P2 resumed for the Core caller and will not guess wire fields or enable follow_up. Active whole-phase owners are P2/P8/P9: P8 is implementing an offline fake-provider evaluation runner; P9 is working on safe Linux/WSL release source. P4/P6/P7 returned PARTIAL. Added SA-021. No checks ran; the repo-only boundary and implementation-first hold remain active. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Owner refresh — 2026-10-21 06:27 UTC:** Active whole-phase owners are P1, P4 and P8. P1's trusted executable identity closure and manifest-backed fixture source are present but untested; the durable one-use fresh-turn issuer remains in progress, and terminal owner-loss proof remains unresolved. P2 returned PARTIAL: `follow_up` stays unavailable; usage-before-effect and bounded pending-message projection source is present but untested. P6 added the SDK/AssistantMessage `UsageProvenance` projection and strict schema fixtures, then returned PARTIAL; no checks ran. P7 returned PARTIAL with no additional safe source gap. Added SA-021 for multi-phase orchestration/recovery acceptance. The benchmark runner and uplift evidence remain absent; HUP items are test contracts only. See §32.40–41 for staged benchmark and CodeMode acceptance. Repository-only boundary and implementation-first hold remain active. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Owner refresh — 2026-10-21 06:14 UTC:** Active whole-phase owners are P1, P2 and P6. P1 is fixing a newly found executable identity gap: Core's control-launch allowlist currently trusts an absolute path by basename and needs trusted resolution before dispatch; durable janitor completion proof remains blocked. P2 is implementing or retaining fail-closed the documented child safe-boundary follow_up path. P6 resumed to type the canonical usage provenance through the generated SDK and re-audit remaining safe provider/settings gaps. P7 returned PARTIAL: replay consumer exceptions trigger canonical resnapshot; Debug usage projection is bounded to 256 recent messages/16 rows max (8 default), with provenance unknown when SDK data is absent. Automation invocation has no approved timezone scheduler; checkpoint restore/artifact settlement remain gated on P1/P2/P8; terminal graphics stay text-only. P5 is SOURCE-COMPLETE for unblocked work; dispatch remains gated on P1/P6. P8 is PARTIAL; P3/P4/P9 remain open. §32.40/41 carry the new evaluation and CodeMode acceptance additions. No checks ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Owner refresh — 2026-10-21 06:08 UTC:** P4 returned PARTIAL after adding the DAP constant-false effect gate and correcting DAP/REPL fixtures to reject route-registration/self-asserted-quota bypasses; no checks ran. P8 is now the third active whole-phase owner for resource/worktree/durable-worker/RC0 source completion alongside P1 and P2. Do not claim unsupported OS CPU/memory/FD/process quotas; keep worker fan-out and cache eviction disabled pending P1/P2/P8 proof. P3 remains PARTIAL with its scan-work and exact-document-digest source changes unverified. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Current implementation handoff — 2026-10-21 06:03 UTC:** P1/P2/P4 are the active whole-phase owners. P1 delays Linux terminal exit evidence until its bounded janitor sweep verifies an empty process tree and fails closed on incomplete `/proc` observation; a synchronous regression fixture was added but not run. Fresh-HostKernel durable janitor completion proof remains unresolved. P1 also owns newly identified Core process/PTY origins (`core/src/process.ts`, `core/src/pty/{pty.bun.ts,pty.node.ts}`, process/PTY portions of `core/src/session/supervisor.ts`) for migration through Rust or pre-spawn disablement; P3's RepoIntel digest changes in the supervisor must be preserved. P2 owns the managed usage-before-effect ordering defect in HorizonCode's processor/LLM/ToolBatch path (not the separate Core SessionRunner); no fixture has been executed. P3 returned PARTIAL after adding a separate 4 MiB repeated-selector scan-work cap, exact-continuation/forged-anchor/missing-anchor/work-limit fixtures, and exact-text BLAKE3 verification of HostKernel document responses in Core. Its fixtures remain unrun, and parser, overlay, guarded-query/cursor, and cache acceptance depend on P1/P4/P8. P5/P6/P7/P8/P9 remain PARTIAL/queued pending slot release and dependencies. No validation, provider, benchmark or release command has run. The absolute repository-only boundary means the external attachment and remote services are inaccessible. The mixed unstaged/untracked tree is preserved. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**P1 source continuation update (2026-10-20, implementation only):** HostKernel now has a
Rust-owned BYO pause/resume path across `execute_search_cascade`, secret authorization,
one-use begin/settle/UNKNOWN, and `resume_search_cascade`. Resume validates binary response
bytes against the durable settled receipt, keeps the approved route order, records truthful
SecretBroker transport provenance, continues fixed keyless routes, and settles known
SUCCEEDED/EXHAUSTED aggregate and Attempt receipts. Added deterministic-cursor recovery for
a lost initial WAITING_SECRET reply, read-only continuation resolution for lost resume
responses, and exact-pin cancellation fencing. Direct Attempt scopes are supported for
read-only search only after the existing profile/scope validator passes. HostKernel web
search readiness remains default-off. No tests/builds/typechecks/audits/provider calls or
Git operations were run; this source is unverified and not release evidence. Remaining P1
work: fresh-process verifier quiescence/no-live-command reconciliation, complete Guarded
origin matrix, protocol IO integration acceptance, and final revision tests; preserve
fail-closed gates until those pass.

**P5 web-search source reconciliation (2026-10-20, implementation only):** the approved
five-route keyless default chain and six explicitly enabled BYO routes are source-composed
through Core ToolBatch planning, one aggregate HostKernel Guard lease/receipt, fixed Rust MCP
and HTTP route policies, and P6's Auth-owned SecretBroker sender. HostKernel's per-route
PREPARED/DISPATCHING/SETTLED/UNKNOWN journal, BYO continuation, cancellation and exact-pin
read-only recovery are source-present; Core validates the bounded response against the durable
receipt and never retries a provider send. The legacy direct HttpClient search helper is pure
parsing only. `WEB_SEARCH_RUNTIME_READY=false` remains: no route can dispatch until integrated
P1 Guard/ExecutionHost and P6 SecretBroker acceptance passes. Provider health is not probed,
cost for BYO remains UNKNOWN, and grounded-model search has no adapter. No tests, builds,
typechecks, audits or provider calls were run for this source reconciliation. P5 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.

**Verified remote source baseline:** `sarv-projects/horizoncode` `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54` (14 October 2026).  
**Merged source/contract update:** PR #7 landed in upstream `main` at `db36dfdc40dad221078839a0aa4a98539e45b0d2` on 15 October 2026. It includes Core ToolRegistry/Rust managed-control source and regression tests, not only Markdown. Local merge and validation status is recorded in `CURRENT_RUN.md`; verify CI and tests on the exact integrated HEAD before release claims.
**Implementation completion:** **NOT V1 RELEASED**. Documentation changes are not proof of implemented features. Recheck latest Git SHA, workflow and local status before editing; the connected GitHub repository cannot verify the user's local dirty tree.

This is the **current observed implementation-status entry point**, not a new design authority. The architecture is `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → exact topic owner. The implementation dependency queue is `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` (Gate 0–10, RC0–RC5). Root `CURRENT_RUN.md` is a dated work/evidence diary. Full superseded status chronology was preserved unchanged in `docs/architecture-archive/2026-10-15-handoff-pre-jcode-adoption.md`; older audit snapshot remains preserved in the existing archive.

## 2026-10-20 08:30 UTC — P2 managed vertical source handoff

P2 remains **PHASE_PARTIAL / NOT VERIFIED**. Its latest source review corrected two integration mismatches: managed child output now uses BLAKE3 for HostKernel quiescence receipts while direct Attempt result payloads retain SHA-256 (`packages/opencode/src/session/managed-control.ts`, `packages/opencode/src/tool/task.ts`); Core accepts the bounded `reason` emitted by Rust for verifier UNKNOWN and checks the observed `sourceRevision` against `finalRevision` for every verifier status. A source assertion was added in `packages/opencode/test/session/managed-control.test.ts`. No tests, builds, typechecks or audits were run.

P2 found no independent source implementation task remaining in this pass. Acceptance stays blocked on P1's guarded verifier dispatch, callback/quiescence proof and fresh-process UNKNOWN/no-live-command reconciliation; P8's exact final-Inspect receipt recovery and capacity settlement; and then integrated P2 pause/cancel/restart/stale-review/workspace-conflict evidence. Keep verifier dispatch and finalization disabled until those dependencies pass. See the 08:30 UTC entry in `CURRENT_RUN.md` and the P2 row in the operative plan.

External source pins, license and copying review: `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` (non-runtime evidence; current implementation status stays in HANDOFF).

## 2026-10-20 09:03 UTC — latest source-only owner refresh

The current phase owners are P1 Guard/ExecutionHost, P3 RepoIntel, and P7 streaming/artifacts/automation/rewind; the parent continues P5 and cross-phase integration. P6 returned PHASE_PARTIAL after removing the TUI `-nano` exclusion that contradicted the approved free-model eligibility rule. No provider request was made. P5 remains fail-closed: Rust and Core source implement the agreed auth-4xx behavior (record the route failure and continue only to another explicitly enabled route, with no retry of that route), ordered cascade planning, bounded retries, route provenance, and exact metadata-only UNKNOWN recovery, but HostKernel runtime readiness stays false pending the complete P1 Guarded transport integration and later acceptance. P2 remains PHASE_PARTIAL pending P1 verifier/quiescence and P8 settlement recovery. No tests, builds, typechecks, audits, or probes were run. All file/process work stays inside `agentx`; preserve the mixed Git state, with no stage/commit/push/cleanup.

P3/P8 cache ownership is explicit: P1/HostKernel owns the actual retained RepoIntel `Arc`, lease pins and retirement callback; P8 owns only its existing cache metadata/planner. P3's Core observer can emit trusted host-fact metadata only behind a disabled sink. Cache eviction remains off until P8 plans a candidate and HostKernel revalidates the exact generation with no live query pins, retires it, and supplies a fresh observation; no estimated freed-byte claim is allowed.

P3 has now added a pure cache-owner projection under `packages/core/src/session/repo-intel-cache-owner.ts`. It is unconsumed until the authenticated P1/P8 bridge exists; physical allocation and reclaimed bytes remain unknown, and no registry key is emitted without a trusted build identity. Regression test source exists but was not executed.

## 2026-10-20 09:05 UTC — phase slot handoff

P3 returned PARTIAL after completing its currently unblocked source changes. P8 now owns the whole remaining resources/workers/worktrees/RC0 phase alongside P1 and P7. Its exclusive source scope is the existing resource sampler/budget, durable worker, worker-pool, worktree lifecycle and RC0 modules; HostKernel stays P1-owned. P3's remaining tasks are the authenticated P1/P8 cache bridge, real editor-buffer source, parser support and P4 document-reader composition. No validation run; V1 remains PARTIAL / NOT RELEASED.

## Latest reconciliation — 2026-10-19 18:01 UTC

This supersedes the older roster snapshots below: the user asked to stop all subagents, and the live agent list now contains only the parent. No phase owner is running. The OpenCode/Codex source crosswalk is recorded in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` §42.12. It inventories the two local source trees and documents phase-specific reuse/adaptation/rejection decisions; it does not prove Horizon implementation or acceptance. No source code was copied in this source audit.

Current work remains PARTIAL / NOT RELEASED. The implementation-first hold remains: no tests, builds, typechecks, audits, provider probes or other validation workloads until source implementation closes. C: `/mnt/c` has 60 GB free (87% used); `node_modules` is 2.5 GB. `kernel/target` and `indexd/target` are absent in this checkout. One main worktree remains on `main`, 12 commits ahead of `origin/main`, with extensive mixed staged/unstaged/untracked changes. Preserve all state; ownership is not clear enough for staging, commit, push or cleanup.

## 2026-10-19 — live quota-reset continuation (supersedes the dated snapshots below)

**V1 remains PARTIAL, not verified or released.** Current workspace is the shared `main@6c8c5ab9a` checkout, 12 commits ahead of `origin/main`, with mixed staged/unstaged/untracked changes and no conflicts. Preserve all existing changes; no staging, commit, push or cleanup has occurred in this continuation. The current three child slots are occupied by whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel/indexd, and P6 providers/settings/Doctor/S1. P6 has released the serialized Bun slot to P3; P1 owns the next Bun run. P1 remains the Rust build owner. P2, P4, P5, P7, P8 and P9 remain queued/partial and must be dispatched as slots open.

**Fresh evidence:** P1 reports `packages/opencode/test/tool/task.test.ts` 15/15 (117 assertions) after moving abort handling to the pre-created Attempt bridge; its enabled-origin no-effect matrix passed 34/34 (127 assertions) across MCP, plugin/hook, formatter, upgrade/install and LSP install/probe origins. Earlier this wave's Rust ToolBatch suites passed 8/8 and 9/9. A P1 interpolation acceptance selector still has 4 pass / 1 fail: the guarded positive shell interpolation is denied because assessed consent guarantees are absent; the negative no-spawn cases pass. Do not weaken that predicate. P3's ArtifactSearch suite passed 19/19 (108 assertions), its RepoTools forged-authority/stale-reference checks passed 2/2, and the full RepoIntel/RepoTools suites passed 54/54 (366 assertions); its unavailable-layer selector passed 1/1. P3 is continuing inert store/lifecycle work; the production RepoIntel query route stays unavailable until P1 provides an authenticated principal/Session-or-Attempt/Location/PermissionV2-bound read grant. P6 repaired its reported Core typecheck diagnostics; `packages/schema` typecheck passed, and Schema Skill/SecretBroker tests passed 8/8 (30 assertions). The final product-level `bun run horizoncode:typecheck` has not passed on the integrated revision. Remaining observed diagnostics are P1-owned Core supervisor/Git fixtures plus the unchanged `packages/opencode/src/storage/storage.ts` migration calling removed arbitrary `Git.Interface.run`; P1 has approved ownership of this narrow diagnostic and will replace it with typed read-only GitV2 operations. P6 still owns all remaining P6 acceptance.

The overlay audit just passed: `compared=6627 changed=283 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` was clean. ActivityStream is already mounted in the TUI session route; its rendered route/replay/large-history acceptance remains open. P5 has non-effectful cascade/config/Settings scaffolding for built-in, Brave and Exa, but the Guard readiness flag remains false and BYO routes are not connected to SecretBroker; provider dispatch, ordered failure/429/exhaustion acceptance and the final enabled cascade remain open. P6's offline Doctor intentionally reports UNKNOWN where effective configuration/catalog cannot be established safely; a real HTTP-handler test traps fetch and proves zero network/credential echo. Its question.ask live route and mixed-effect/spoof tests exist but still need final integrated rerun. C: has 22 GB free (96% used), `kernel/target` 12 GB, `indexd/target` 235 MB, `node_modules` 2.5 GB. No HorizonCode Cargo/Bun/typecheck process was running at the last check; preserve shared build outputs and avoid duplicate heavy work.

**Immediate sequence:** P3 has released Bun; P1 now fixes the remaining Guard/supervisor/Git diagnostics and resolves the positive interpolation guarantee without weakening authorization; P6 continues source-only phase work; P3 continues source-only indexd persistence/lifecycle work. Dispatch P2 as the first whole-phase owner when a slot opens. Keep unsupported/unevidenced effects unavailable. Rerun the integrated A1 typecheck, full required audits/gates and real journeys only after source settles; native Windows remains unavailable, and no push/release claim is supported yet.

**Latest continuation update — 2026-10-19 15:24 UTC:** User directed implementation first; no validation commands are to be started until implementation scope closes. Current active whole-phase owners are P6 providers/settings/Doctor/S1, P7 streaming/artifacts/analytics/automation/rewind, and P8 resources/workers/RC0. P1 and P2 owner sessions hit usage limits; P5 is unowned and P6 will take its web-search cascade after P6/S1 core work. P1 is first in the dispatch queue because dependent effects remain blocked. P3/P4/P9 and final release work remain PARTIAL or queued. Recent source-only movement: P6 added authenticated QuestionV2 routes and an opaque SecretBroker lease seam; P7 is replacing text-length replay cursors with source ordinals, separate offsets and fresh stream generations; P8 is adding an OwnerLog-bound worktree intent/receipt journal and RC0 owner-snapshot ingestion. These changes are not verified, and no effectful path is enabled from them. Production managed verification remains unavailable (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE = false`) until the independent typed verifier path is completed and its Guard/artifact prerequisites pass. Git remains mixed staged/unstaged/untracked on main, 12 commits ahead; preserve it, do not stage/commit/push/clean up. `/mnt/c` has 21 GB free; `kernel/target` is 2.3 GB and `indexd/target` is 292 MB. A long-lived Bun PTY selector with a HostKernel child has no currently listed agent owner; it was left untouched and does not count as release evidence.

**Owner refresh — 2026-10-19 15:34 UTC:** The P6/P7/P8 source-only owner sessions returned PARTIAL, so the three available child slots are now assigned to whole-phase P1 Guard/ExecutionHost, P2 managed vertical/independent verifier, and P4 LSP/DAP/REPL. P6/S1 and P5 remain PARTIAL; P5 web search remains hidden pending P1 Guarded outbound transport. P7 event sequence/generation work is source-present but its Rust artifact/checkpoint/automation integrations remain blocked on P8. P8 durable worktree/RC0/sample attribution code is source-present but needs P1 HostKernel integration and P2 final-verifier evidence. The new P1/P2/P4 owners were instructed not to run tests/builds/typechecks until all implementation is complete. V1 remains PARTIAL / NOT RELEASED; no code was staged, committed, pushed, cleaned or pruned.

**Latest owner update:** P3's new bounded generation store and debounced watcher invalidation passed `indexd` tests: generation_store 5/5, watcher integration 6/6, library watcher 8/8; rustfmt check is clean. `indexd/target` grew 235→267 MB and C: had 24 GB free. P3 released Cargo to P1. P3 keeps symbol/reference tools typed UNAVAILABLE until P1's authenticated HostKernel read grant and P4's supervised LSP boundary pass. P1 reports Core typecheck now passes after consent and fixture repairs; it still needs the full HorizonCode CLI-host package/TUI/Core A1 command. Its terminal approval fix must show an important host-derived safe argument summary; if that cannot be produced without exposing secrets, keep Allow unavailable. P6 has added an unverified RED test and source change to prevent plaintext `auth.json`/`OPENCODE_AUTH_CONTENT` reads; it must run after P1 releases Bun and continue durable SecretBroker/credential migration work. These updates do not change any phase to VERIFIED.

Read in this order:

1. AGENTS.md
2. arch_V1/README.md
3. arch_V1/17-GOVERNANCE-DECISIONS.md
4. arch_V1/10-DELIVERY.md
5. arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md when external source reuse is involved
6. this file
7. docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md

## 2026-10-18 — current implementation continuation

The user resumed implementation and requested full work on A1–A4 plus P1, P2, P4, P5, P6/S1 and P7. Whole-phase owners currently active in this shared checkout: P1 Guard/ExecutionHost, P2 managed-control vertical and P7 stream/artifacts/automation/rewind. P4, P5 and P6/S1 are queued for the next available child slots. P1 remains the first shared Cargo build owner; do not start another heavyweight Rust build until P1 releases that slot. No phase is VERIFIED or V1 RELEASED from this continuation.

**Current source reconciliation:** `packages/tui/src/routes/session/index.tsx` mounts `ActivityStream` at line 1663. The stream is now on the rendered session route, but P7 still owes route-level acceptance, large-history loading, replay/resnapshot, final-revision evidence and the rest of the P7 scope. The P5 implementation remains stale: `packages/opencode/src/tool/registry.ts` still says built-in search is deferred and gates only Exa/Parallel flags; `websearch.ts` selects one provider rather than the approved ordered built-in plus user-enabled BYO cascade. P5 remains implementation work; no search route may become effectful before P1 Guard acceptance.

**A4 overlay evidence:** after adding an exact `.gitignore` exception for the first-party `packages/opencode/test/tool/skill.test.ts`, `python3 scripts/architecture/audit_overlay_visibility.py` returned `compared=6627 changed=242 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0` (exit 0). This is a checkpoint result; rerun after all phase integrations because new files may change the result. Git remains heavily dirty on `main@6c8c5ab9a` (12 ahead / 0 behind), with no conflicts; preserve all existing staged, unstaged and untracked changes. No commit, push, cleanup or remote mutation occurred.

**Phase evidence received:** P7 owner reports its focused renderer/stream suite at 80 passed / 0 failed / 1,022 expectations; parent has not rerun it. The owner confirmed those tests do not yet mount the full Session route and is adding the strongest route integration harness. P1/P2 work and all remaining P4/P5/P6 acceptance are still in progress or queued. Keep cancellation/restart/UNKNOWN, Guard-denial, distinct reviewer, actual workspace revision and independent verifier gates fail-closed until verified on the integrated revision.

## 2026-10-18 — stop-for-today V1 checkpoint

The user asked to stop implementation for today and leave a restartable record. **HorizonCode V1 is not complete or released.** The detailed phase ledger and resume plan are in the final `2026-10-18 — stop-for-today V1 continuation checkpoint` section of `CURRENT_RUN.md` and the matching checkpoint in `implementationtov1release.md`.

**Both `horizoncode` and `hzcode` must start the CLI** — decision finalized 2026-10-18: `horizoncode` canonical, `hzcode` short command, same entrypoint/runtime, no second implementation. Implemented same day and reconciled across A-V2-27, root `AGENTS.md`, the operative plan and `arch_V1/10-DELIVERY.md`; `packages/opencode/package.json` bin map and `install` provision both names. Verified: sandboxed installer installs and runs both; both npm-bin shims spawn the same wrapper; real CLI starts (`bun run ./src/index.ts --version`, exit 0). Deeper package-scope/import renames remain the staged post-V1 migration.

**Design-hole closure assignments recorded 2026-10-18** (full audit `CURRENT_RUN.md` §8; gates `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.4): OS-confinement backend (`horizoncode-sandbox`) → **P1** — crate PHASE_VERIFIED (24/24 tests, 2026-10-18); parent source audit on 2026-10-19 confirms HostKernel terminal-consent and stdio preflight/launch call paths reach `spawn_prepared`. This corrects the historical “wiring remains open” note: source status is **WIRED**, while product containment, denial, mismatch, cancellation and recovery acceptance remain open. §42 SRC-026 recorded. Checkpoint/rewind LLD closed (`§14.19/§16.18/§31.18`), wiring **P7** + **P8** acceptance; HorizonCode-as-MCP-server → post-V1 `DEC-V1-23`; editor/IDE extensions beyond CLI/TUI → post-V1 `DEC-V1-24`; **built-in web search → promoted into V1 on 2026-10-18 (`DEC-V1-26`)**: built-in default route + BYO-key provider cascade with Settings control, per §37.5/§16.7/§32 (implementation remains incomplete). Derived navigation for final V1: `arch_V1/45-V1-EVENT-FLOWS-ATLAS.md` (non-normative synthesis; owners win on conflict). No feature status was promoted.

### Phase status at pause

| Phase | Last reported evidence | Remaining gate |
|---|---|---|
| P1.3 Guard | Owner reports Core runner **93/0** (308 assertions), write/registry **27/0** (71 assertions); stand-down ack: `terminal-run-live` user-origin/over-limit subset **2 passed / 31 assertions**. **2026-10-25 delta (see "P1 `revert.commit` principal gate" + "P1 `session.revert.*` denies 403 family-wide" + "P1 supervisor startup diagnostics / regeneration outcome" below):** `session-revert-principal` **5/0/18**, revert+launch+process-guard+ripgrep+tool-bash **33/0/113**, read-batch **27/0/447**, `server: session-revert-authorization` **7/0/45** (family-wide 403 table), `session-supervisor-launch` **18/0/53** (new stderr/exit-status diagnostics), `tsgo --noEmit` core **0** / server **0** / sdk-next **0** / client **0**. **Open:** regeneration — item 1 `packages/client` **blocked** by a HEAD condition in `packages/schema/src/skill.ts` (`skills.skill.list.success` non-portable) so CI `check:generated` still cannot pass; item 2 `packages/sdk/js` **stopped** at the 21,306/21,650 diff stop-condition, half-patched output + a destroyed other-owner hunk awaiting the parent's decision. | Shell/interpolation, Task/subagent, enabled-origin closure, multi-call ToolBatch, leases/receipts/UNKNOWN, cancel/restart, native Windows; wire the verified `horizoncode-sandbox` backend into ExecutionHost (§14.5). |
| P2 managed control | Owner reports managed-control client **15 passed / 63 expectations**; typecheck exits 2 on 3 diagnostics in `test/session/llm.test.ts` (L822/834/839). | Authenticated reviewer, Attempt-issued intent/lease, live workspace revision, independent verifier, Core→TUI delivery. Keep execution/finalization disabled. |
| P3 RepoIntel | No edits/tests in final continuation; prior owner report **44 passed / 342 expectations**, not rerun. | Authenticated bounded HostKernel indexd bridge; ~72 MB frame exceeds 6 MiB RPC cap. Keep symbol/reference production route unavailable. |
| P4 LSP/DAP/REPL | Owner reports full focused suite `test/lsp test/dap test/repl` **198 tests / 654 expectations passed**; typecheck exits 2 with diagnostics in `test/session/llm.test.ts` and TUI files. | P1 Guard, trusted executable resolution and OS confinement; effectful production paths remain unavailable. |
| P5 | Web search promoted to V1 (`DEC-V1-26`, 2026-10-18); browser/desktop deferred by A-V2-31. | Web search: built-in default + BYO-key provider cascade + settings/provenance; browser/desktop unavailable. |
| P6 + S1 | Earlier parent-run settings/questions **43 passed / 132 expectations**; live question route/TUI suites **4/4** and **15/15**. Free provider is accepted but quota-bound (429). Doctor schema/projector **4 tests / 18 assertions**, MCP/index/HTTP **6 tests / 46 assertions** reported by owner; latest S1 checks verified: `tool-filter` 1/1, tools 2/2, ToolBatch 51/51; typecheck blocked by 3 diagnostics in `test/session/llm.test.ts` (L822/834/839). | Free-model 200/coding task only after quota reset; no paid fallback. Doctor offline route/TUI invocation, complete S1 ToolBatch/projection/denial and settings/catalog/provenance acceptance remain. `.gitignore` parent-owned (A4 clean). |
| P7 stream/artifacts | Owner reports `collapse-tool-output` **10 passed / 46 assertions**; activity stream still not wired to the route; raw tool args and raw ReasoningPart body can still render. No rendered TUI/cassette journey. | Real route integration, redaction/total bounds/order/expand/focus/scroll tests, replay/resnapshot, artifact/automation integration. New activity-stream component/test and transcript-window test are now Git-visible (A4 done). |
| P8 resources | Owner reported at handover: sampler attribution race + durable capacity-revision drift + task-verification gap fixed; `cargo test --test resource_sampler --test worker_durable --test task_dag --test worktree_pool` → **152 passed / 0 failed**; rustfmt clean; RC0 Python **48 passed**. | Worker control needs authenticated P2 ingress (boundary proposal recorded in `CURRENT_RUN.md` handoff ledger); no eligible product 1/5/10/20 baseline or fan-out. |
| P9 release | Prior readiness **46/46**; release gate **BLOCKED with 20 blockers**, install matrix `NOT_RUN`. | A4 visibility (**done 2026-10-18**: overlay audit 0 hidden / 0 stale), candidate/license/install/platform and final CI gates; no product install, signature, legal decision or publication. |

### Dirty-tree ownership and subagent roster (2026-10-18 ledger)

All work lives in the **single worktree** `/home/sarvesh/business_Dev/agentx` (`main@6c8c5ab9a`, 12 ahead of origin, nothing pushed; counts at ledger snapshot: 150 staged + 71 unstaged + 19 untracked (final), no conflicts). The complete file-group→phase ownership map, phase-owner session IDs, resume mechanics, verified-evidence stamp and next-agent gotchas are in the **"2026-10-18 — HANDOFF LEDGER"** section of `CURRENT_RUN.md` — read it before restarting any phase.

Phase-owner sessions (resume by passing the same sessionID to `subagent`): P1 `ses_eb4ead3d5ffeRPhH6sBFf5yh4m` · P2 `ses_eb4ea6f76ffeWOqS08OuA9sNF5` · P3 `ses_eb5c8750effemMX5TknS2W9BKz` (idle; needs the P2/P3 indexd-bridge contract ruling) · P4 `ses_eb4ea55beffelFV6p02FxIUts3` · P6 `ses_eb4ea9ac3ffeWjhEt6icLS9lu8` · P7 `ses_eb4ea477cfferUPmzt4e6bZocg` · P8 `ses_eb4ea3906ffeV3axR6J4Jg29G3` · P9 `ses_eb4ea22feffeUap4qJxFOPUukA` (idle; release qualification is authorization-gated). P5 stays deferred.

**Post-handoff additions (2026-10-18, same day):** paste-ready next-agent prompt in `HANDOFF_PROMPT.md`; explicit remaining-work ledger (implementation / verification / tests / real-case acceptance / user decisions) in `implementationtov1release.md` §"Explicit remaining work"; `AGENTS.md` now carries the unit-size/concurrency mandate (whole phase per subagent, max safe fan-out, no micro-slicing) and the remaining-ledger duty at every stop; competitive desk-analysis (Codex-verified) in `CURRENT_RUN.md`.

### Tree/process preservation and next start

- Local `main@6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind. One registered worktree. Latest Git status at the 2026-10-18 ledger snapshot: 150 staged paths (69 added, 81 modified), 71 unstaged modifications, 18 untracked paths, no conflicts. Preserve all contents and staged state; no commit/push/cleanup occurred.
- No HorizonCode build/test process remains (final stop check: only harness MCP servers run). The former unrelated user-owned LiteCowork Cargo build has ended; the shared Cargo slot is free — still keep one heavyweight Cargo/TypeScript build at a time on this WSL machine. `df` showed ~824 GB available; `kernel/target` ~3.0 GB and `indexd/target` ~207 MB.
- On restart, repeat the mandatory root bootstrap and Engram reload, confirm phase-owner stop acknowledgments and P6 `.gitignore` ownership, then inspect tree/processes again. Reconcile the both-command decision; continue P1 before enabling dependent effects, prove one P2 managed Attempt before worker fan-out, then resume P7 route wiring and P3/P4 safe work. Run P8's four Rust regressions only after the unrelated Cargo process exits and P1 releases the shared slot.
- Full V1 still requires the accepted Linux/WSL CLI/TUI scope, integrated Guard and managed-work acceptance, all applicable providers/settings/LSP/DAP/REPL/stream/artifact/automation/resource/worker goals, eligible RC0 workloads, both command startup checks, clean install/migration, license/notices closure, final architecture/visibility/typecheck/push/full gates, and independent final-revision evidence. Native Windows remains unavailable; post-V1 surfaces stay deferred; no hidden paid fallback. See the tracker for the detailed release-critical checklist.

## 2026-10-17 implementation wave — verified state and active workstreams

- **S1 follow-up:** reran the Core V2 question route and tool tests → **4 pass / 23 assertions**; TUI question, V2 notifications, and settings tests → **15 pass / 70 assertions**. The live route covers multi-question reply/reject, exact V2 events, and foreign-session denial; notification tests cover V2 asked/replied/rejected dedupe/cleanup. No provider call was made. Focused question/notification behavior has no known open test gap on this dirty tree; S1 remains `PARTIAL` until final integrated-tree verification.

- **Phase packages returned and parent-verified** on the current dirty tree (base `6c8c5ab9a`): P1.3 Guard origin matrix spot-checks (`tool_batch_guard_matrix` 6/6, `effects_host_process` 9/9, `host_terminal_process` 2/2, `effect_host_principal` 11/11, `hz_kernel_process` 2/2); P3 RepoIntel (`repo-intel` 29/29, `artifact-search` 16/16, `indexd cargo test --offline` 58 pass) plus the parent-completed shared grant — new `packages/opencode/src/tool/repo-tools.ts` (`repo_tree`, `symbols_search`, `references_find`) behind `OPENCODE_EXPERIMENTAL_REPO_TOOLS`, `RepoIntel.node` (fail-closed unavailable backend) in the registry graph, and V1 web-search fail-close (`webSearchEnabled` now requires explicit exa/parallel flags) — full `bun test test/tool` 311 pass / 0 fail and `bunx tsgo --noEmit` clean; P4 LSP/DAP/REPL `bun test test/lsp test/dap test/repl` 159/159; P6+S1 settings/question 43/43; P9 release harness 32/32 with the release gate still `BLOCKED` (18 blockers).
- **Free-model access (user decision 2026-10-17):** free models are included under the `opencode` provider in direct mode. Live evidence: the official v2.0.31 client works keyless from this machine; the keyless request identity and gateway acceptance predicates were captured and characterized; the daily free quota (~200 requests) is exhausted (`Retry-After` to ~00:00 UTC). Full findings: `/tmp/opencode/free-model-findings.md`; decision + evidence in `implementationtov1release.md` (Provider and OpenCode SDK decision gate). Not yet done: live HorizonCode acceptance (an accepted-but-quota-bound request reads `429 FreeUsageLimitError`; a predicate miss reads `403 FreeTierError`) and the free-model coding-task runs (pending quota reset).
- **Completed this wave (2026-10-17):** (a) P6-OP + parent last-mile fix — the keyless `opencode` provider now exposes free-only models (`apiKey "public"`, paid hidden, AN-002) with honest 429/403 surfacing and a version-like source-run `User-Agent` (`packages/opencode/src/session/llm/user-agent.ts` + regression test); **the fork's own requests are accepted by the free-tier gateway live** (accepted-but-quota-bound `429 FreeUsageLimitError`); real 200 + free-model coding-task runs are pending the daily quota reset (~00:00 UTC). (b) P2-RPC — `managed.v1` kernel RPC (admit/settle/cancel/snapshot, one-use delivery keys, fail-closed negatives, real-socket tests) + Goal-review dialog mount (`/goal`); scoped `cargo test` **209 pass / 0 fail**, TUI goal-review/app-lifecycle 9/0, tsgo clean. Remaining before C15/C20 release: plan-ingress RPC, TS managed client + TUI delivery route, and the Core tool-batch consumer.
- **Parent repairs this wave:** exact `.gitignore` exceptions now cover the prior P1/P3/P6/P9 paths and current C15/Guard/P4/P7/P8 additions (including LSP launch/server, `question.ts`, managed-control client, SVG worker, worker/DAG tests and fixture). Latest `python3 scripts/architecture/audit_overlay_visibility.py` → **6,627 compared / 230 changed / 0 missing / 0 symlink delta / 0 hidden changed/new / 0 stale unignore**. `apply_patch.test.ts` denial-message expectation remains aligned with P1 Guard wording (`guarded operation set or lease changed`).
- **P3 indexd transport (crate-side only):** `indexd/src/transport.rs` and `handler.rs` now provide the bounded `indexd.v1` codec/handler and documented bridge contract. Parent reran `cd indexd && cargo test --offline --locked` → **97 passed / 0 failed**; the owner reports fmt, clippy and rustdoc clean. The kernel `indexd.v1` bridge, supervised `hz-indexd` lifecycle and TypeScript backend replacement remain open, so RepoIntel symbol/reference queries still fail closed with typed errors. Bridge work is queued behind the C15 owner's `host_kernel.rs`/`hz-kernel.rs` changes.
- **Tooling note:** subagent *continuations* of previously-completed sessions were persistently rate-limited this day; fresh owner sessions worked.

## Canonical ownership and non-negotiable rules

- HorizonCode direct Core (OpenCode-derived) alone owns direct Session/Input/Message/Part and provider-turn continuation; provider transport is replaceable only through approved A-V2-27.
- Rust owns Horizon managed Goal/SpecVersion/Run/Task/Attempt, Guard/ToolBatch/EffectIntent/lease/receipt, independent Evidence/Verification and resource/worktree ownership. It **does not** own another conversation transcript.
- Native OpenCode adapter, if selected, owns its **separate native sessions** only, with explicit bounded Horizon links.
- Every enabled mutation origin requires pre-dispatch Rust Guard → durable effect admission → one-use lease → authorized host/worker → receipt/UNKNOWN. An inability to pre-authorize hosted/provider-executed effects means they are unavailable, not silently allowed.
- User-selected provider/model/harness and cost class do not change without configured explicit permission; no hidden paid fallback. No automatic worker/cache/process cleanup without confirmed ownership; do not destroy user-owned files/dirty worktrees or unowned builds.
- Defined/Proposed/Code present/Wired/Tested/Verified/Released are different statuses. Neither docs, schema, UI placeholder, single green CI build nor JCode benchmark claim can upgrade runtime status.

## Source-grounded baseline and outstanding gates

| Gate | Existing evidence on the observed main branch | Missing before calling it complete |
|---|---|---|
| P0 source reuse | Pinned `opencode/` snapshot; overlay/bootstrap/audit scripts and source maps; earlier validation checkpoints | Release license/notice/package and clean-machine proof at P9 |
| P1.2-B observer | `packages/core/src/session/supervisor.ts` + `kernel/src/bin/session_supervisor.rs` + projection/handshake; a **separate Linux Rust process per watched direct Session** | Complete supported-OS lifecycle, failure/restart, and resource benchmark evidence; shared daemon is only a candidate |
| P1.3 Guard | `kernel/src/guard.rs`, `effect_host.rs`, V1/V2 ToolBatch gate, guarded write, bounded stream/cancel; PR #7 now additionally gates Core registry effects on Rust admission, filters unsupported effects and rejects application/plugin `files.write` identity spoofing with focused Bun tests | Source-specific shell/process, Task/subagent, plugin/MCP/hook, hosted-provider, LSP/DAP/REPL, browser/desktop/network/automation no-bypass proofs; complete lease/receipt/UNKNOWN settlement |
| P2 managed control | `kernel/src/owner_log.rs`, `managed_control.rs` and tests for accepted spec, Task/Attempt restart/UNKNOWN; PR #7 now also transitions PAUSED+UNKNOWN admitted Attempt to RECONCILING with durable replay and unsafe-resume regression | **Non-executing internal admission state only**: authenticated full reviewed SpecVersion RPC, real Task DAG scheduler, worker/resource leases, effect reconciler, independent verifier/verified final revision and end-to-end real work |
| P3/RepoIntel | Existing OpenCode-derived coding path and `indexd/src/lib.rs` bounded lexical generation/overlay/cursor foundations | Revision-safe edit/search, symbol/reference/LSP service integration, latency/task verification |
| P4 V1 capabilities / P5 web search + deferred surfaces | Existing source/tooling and design/service seams | V1: Guarded LSP/DAP/REPL, web search broker, Linux/WSL task acceptance. Post-V1: browser/desktop runtime. |
| P6 V1 CLI/TUI | Existing OpenCode-derived models/tools/extensions plus initial Features UI and feature-exposure code | OMP-adapted providers/settings/TUI, full effective/locked/source/pending settings state, extension security and evidence; web/desktop parity is post-V1 |
| P7/P8 V1 CLI/TUI and resource control | UI architecture and durable control foundations; bounded Rust process-local resource-reservation and worktree-lifecycle models with focused tests | Stable streaming/render/artifact/analytics/automation paths, durable/runtime resource and worktree controls, worker controls, long-horizon recovery/verification and measured performance; no web/desktop surface requirement |
| P9 shipping | README/product direction, scripts and prior GitHub CI history | Root redistributable license, native Windows durability/sandbox/process support, other platform qualification, installer/migration/signing/privacy/performance gates |

**Merge chronology correction:** PR #4 was merged on 14 October 2026 (main commit `03691d7852f2`); its internal managed-state implementation is **not** the production managed executor. Historical “PR #4 still open/CI pending” passages exist only in archived logs. The README-only commits after it do not establish runtime progress. No open PRs were observed when baseline was queried; PR #7 is this documentation effort.

**Experimental settings:** `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/dialog-features.tsx` and `packages/app/src/components/settings-v2/features.tsx` are present on the reviewed main branch. This is **CODE_PRESENT/PARTIAL** initial config/UI, not proof of every `FeatureExposureV1` source-precedence/lock/pending/API parity or enabled experimental backend. Experimental remains OFF unless eligible, explicitly opted in and authorised; an unavailable backend cannot be turned on by UI alone.

## New JCode adoption decision — A-V2-30 (DESIGNED only)

**Source research:** `1jehuang/jcode@1f612a7` and user-supplied `jcode-godmap.zip`, pinned in §42.9. Upstream vendor RAM/PSS figures and experimental documents are **not independently reproduced Horizon measurements**. The architecture and task inventory now include 24 candidates with a complete §42.10 crosswalk and RC0–RC5 delivery gates.

| Workstream | Source owner | Actual status at this handoff | Exit evidence |
|---|---|---|---|
| Whole-product memory/process budget | §18.17, §37.16, RC0 | **DESIGNED**, no first-party comparable benchmark | Exact-machine total process-tree PSS/RSS/CPU/FD/cache/disk/local-model VRAM at 1/5/10/20 Sessions; raw reproducible baseline, native OS metrics |
| Shared Rust virtual Session service | §01/§13/§20/§05/§14, RC1 | **PROPOSED**; current Linux observer is per Session | Read-only multiplex prototype then authenticated cross-session isolation, crash/recovery, fairness and Guard parity; measured improvement before effect-host cutover |
| Bounded headless workers and Task DAG | §15/§21/§29, RC2 | **DESIGNED**, internal P2 state only | Authenticated scheduler/leases, typed artifact edges, realistic concurrent tasks, independent revision-bound PASS |
| Provider Doctor / prewarm | §15/§33/§37, RC3 | **DESIGNED**, use existing provider transport | Offline no-network tier, bounded catalog test, explicit-consent full tool/chat/stream test, no paid fallback |
| File-touch and stale-write conflict handling | §21/§33, RC2 | **DESIGNED** | Advisory file-touch index and hard revision digest/lease denial under user edits and competing agents |
| RAM caches/local memory retrieval | §18/§30/§31, RC3 | **DESIGNED** | bounded bytes/TTL/entries; opt-in scoped recall and secret/privacy negatives |
| TUI redraw, live tool-tail, resource dashboard | §16/§31, RC4 | **DESIGNED**, underlying UI exists | idle/full-frame reason, stable prompt focus, bounded 10k-message streams, source-truth telemetry |
| SDK, import/resume, terminal steering, builds, optional mobile/self-dev | §13/§16/§33, RC3/RC5 | mix of existing underlying direct-session steering and new **DESIGNED** adapters | §42.10 mapped acceptance: no dual owner, authenticated clients, source provenance, rollback |

The accepted 20 base regression cases are `JC-RES-001..020` in §32.32, with additional required reservation/authentication subfixtures `JC-RES-012.C–L` in §32.37. The measurement protocol at `docs/performance/README.md` is a **runbook and unexecuted empty template**. Executable pieces include `scripts/perf/rc0.py` (29 unit tests pass), `kernel/tests/resource_sampler.rs` (9 tests previously passed), `kernel/src/resource_budget.rs` (20 focused budget/reservation tests pass), and `kernel/src/worktree_pool.rs` with `kernel/tests/worktree_pool.rs` (30 pass). The budget and worktree owners remain process-local models, not OwnerLog/runtime services; the worktree pool does not manipulate filesystem worktrees. **No 1/5/10/20 raw baseline capture is eligible or produced**: live Session owner identities and matching task outcomes are unavailable, so RC0 remains `NOT_BASELINE` and no optimization result is implied.

## Exact next implementation slice

*(2026-10-17 note: the wave section above supersedes this ordering for current status; the P1.3 host-kernel detail below is kept as historical record.)*

**P1.3 host-kernel prerequisite, then first direct origin.** The normative §§14/37 architecture selects a host-scoped `hz-kernel`; do not revert the Session supervisor into a second effects owner. *(Status 2026-10-15 evening: `hz-kernel` builds; `kernel-projection-live.test.ts` is 10/10 (104 assertions) against the real host, and `terminal-run-live.test.ts` is 7/7 (68 assertions) for the guarded session-batch run path. The latter proves deny → zero spawn, approved real execution with receipt and both truncation flags, one-use lease replay rejection, timeout without orphan process, and durable UNKNOWN when dispatch is withdrawn. This does not yet prove the Core `Pty.runUser` UserAction route.)* Remaining P1.3 work, in order:
1. ~~Fix user-origin effects~~ **Rust HostKernel/EffectHost path implemented 2026-10-15**: `guard.rs` splits `EffectOriginKindV1` (`SessionBatch` requires Session + sha256 turn context for every action including `terminal.run`; `UserAction` is `terminal.run`-only, needs principal + explicit approval, and cannot claim files.write), and the origin kind is fixed by the Canonical operation rather than a caller-supplied field. Core `Pty.runUser` calls `prepareUserEffect` and then the same host execution path; existing Rust principal tests pass, but a real Core-through-host user-origin test is still required.
2. ~~Make reconcile echo the prepared operation~~ **done 2026-10-15** (`kernel/src/effect_host.rs` reports `run` for terminal challenges, `write` otherwise, patch targets unchanged) with an exact-value Rust assertion; live `test/terminal-run-live.test.ts` is 7/7 against the rebuilt binary.
3. Retarget all stale `effects.v2` process-integration coverage in `kernel/tests/session_supervisor_process.rs` to the actual `hz-kernel` owner, preserving positive, denial, restart/recovery, and concurrency cases; implementation is underway.
4. Implement the interactive PTY surface (`terminal.start/input/resize/cancel/status`, tickets) in `hz-kernel` through Guard/EffectHost, with bounded replay and restart/UNKNOWN behavior. **Rust side landed 2026-10-15 late** (`kernel/src/host_kernel.rs`, `kernel/src/terminal.rs`, `kernel/src/terminal_process.rs`, `kernel/src/bin/hz-kernel.rs`): subscriptions with bounded replay, explicit `resnapshot_required` on eviction, cursor/digest-bound events, restart status `unknown`/`sessionLost` with empty replay, and a Linux preflight refusal when process-tree cleanup after owner loss cannot be guaranteed. `cargo test --manifest-path kernel/Cargo.toml` is **fully green** (107 lib + 11 `effect_host_principal` + 9 `effects_host_process` + 1 `host_terminal_events_process` + 2 `host_terminal_process` + 10 `hz_kernel_process` + remaining suites), and `cargo fmt --check` is clean. **Consequence:** interactive `terminal.start` fails closed on Linux with `UNAVAILABLE` before lease consumption; only native Windows ConPTY acceptance can demonstrate a live interactive terminal.
   Core side: `subscribeHostKernelEvents` no longer closes the shared host channel on a resnapshot control (subscription-scoped, ACK routed through the delivering subscription, bounded retry budget so a host refusal cannot spin), and `Pty.attach`/`Pty.recoverResnapshot` page `terminal.v1/status` in 64-KiB pages, slice replay by the attachment's own byte cursor, and surface `SessionSupervisorError`/`Pty.UnavailableError` as typed 503s instead of hanging.
5. Latest targeted evidence (2026-10-16): `cd packages/core && bun run typecheck` returned without diagnostics; this was not a full workspace typecheck (the last full-workspace checkpoint remains 26 diagnostics in other owners). `cd packages/opencode && bun test test/server/httpapi-listen.test.ts` is **9 pass / 3 skip / 0 fail** (37 assertions). The former positive external-plugin reuse case was removed after tracing `Plugin.state`: it loads internal plugins and reports configured external server plugins unavailable until Guard/ExecutionHost are wired. Do not treat its removal as plugin runtime acceptance or restore an unguarded path.
6. Canonical `/api/pty` harness correction (2026-10-16): the test helper now uses `HttpApiApp.createRoutes()` with the configured `OPENCODE_SERVER_PASSWORD`, rather than global `HttpApiApp.webHandler()`. Wrong Basic password returns 401; authenticated Linux PTY creation returns typed 503 `ServiceUnavailableError(service=host-kernel)`; the list remains empty. `cd packages/opencode && bun test test/server/httpapi-v2-pty.test.ts` is **1 pass / 4 skip / 0 fail** on Linux. The earlier 403 was test-harness configuration, not missing production authorization middleware. Windows-only live cases are updated to use `cmd` but remain unexecuted; native Windows ConPTY/pipe-auth/Job Object acceptance is open. The prior location-scoped `Pty.Service` fix and `/status` smoke result remain as recorded.

**Parallel safe instrumentation (RC0):** continue qualifying and wiring the §37.17 ResourceSampler only behind existing Rust-owned process/lease identities; measure the whole owned process tree with PID-start fencing, Linux PSS/RSS/CPU/FD and native Windows private bytes as separate methods, local inference separately, UNKNOWN on unsupported/denied counters, and redacted bounded samples. Reproduce the JC-RES-001..004 1/5/10/20-session workloads only when valid owner identities and matching task outcomes exist; no runtime/PSS acceptance is inferred from schema, self-check harness data, or WSL.

**Then P2:** after P1.3 admission and receipt reconciliation pass, implement one accepted SpecVersion → one durable Task/Attempt → one bounded Guard-mediated action → durable evidence/receipt → independent final-revision verifier. Prove pause/cancel/restart/UNKNOWN and human-edit conflict before worker fan-out; then progress to resource/workspace leases and UI/SDK.

**Snapcompact:** source review finds transient request-context imaging and persistent archive compaction are separate. Neither is available in V1; no runtime, setting, command or capability. A later ContextService projection is plausible only after P1.3/context fidelity, exact-model capability and image-aware budget/privacy/cost/recovery proof. See §§16.15.2/30.4 and §42 SRC-024.


**Current code checkpoint (2026-10-16, updated):** the P1.3 host/session implementation remains in progress. `hz-kernel` effects.v2 and terminal.v1 surfaces, bounded PTY replay/resnapshot recovery, and prior Linux real-binary tests are recorded above. This continuation proves the configured `/api/pty` auth harness and Linux fail-closed refusal, and the listener suite is green with 3 platform skips. Open gates: complete P1.3 origin closure; the real `shellImpl → spawner.spawn` Guard path; Core `Pty.runUser` UserAction-through-host proof; native Windows ConPTY/pipe authentication/Job Object acceptance; and the rest of P2–P9. External configured server plugins remain unavailable until Guard/ExecutionHost mediation exists.

## 2026-10-16 — V1 scope boundary (revised user decision; no status changed)

V1 is Linux/WSL-first **CLI/TUI**; native Windows remains truthfully UNAVAILABLE until native acceptance. Web, desktop, browser automation/attached-browser and desktop/computer control are post-V1; built-in web search is V1 (`DEC-V1-26`, 2026-10-18). LSP, DAP, bounded REPL, web search, OMP-preferred providers/settings/TUI, streaming/rendering, artifacts/analytics/automation, worker/resource systems, caches/local memory, Doctor/import and measured resource/performance work are V1 goals—not verified features. The maintained finish/status/source map is `implementationtov1release.md`; dependency order remains in the operative plan under "2026-10-16 — V1 scope decision". P1.3 Guard remains open; the P2 managed vertical must precede worker fan-out. OMP is the preferred source for compatible non-OpenCode provider and CLI/TUI patterns; official OpenCode SDK/API use requires explicit backend/session ownership and real entitlement tests. New adapted first-party modules use HorizonCode naming; preserve licenses/notices and genuine dependency IDs. This scope update promotes no implementation status and does not change observed P1.3/P2/release evidence.

## Verification and continuation procedure

1. Inspect local tree status, pending worktrees, active build/child processes, disk/cache size, configured OS and newest main/PR HEAD. Never treat this remote source read as evidence the user's laptop worktree is clean.
2. Run focused source-owner tests and `bash scripts/architecture/run_push_gate.sh`; for CI/release also run `bash scripts/architecture/run_full_gate.sh` and actual scenario/platform tests. A docs-only CI pass is *not* a performance or runtime certification.
3. Implement one end-to-end vertical slice with a failing acceptance case first; then positive, bypass/negative, cancel/restart/UNKNOWN and workload/perf evidence where applicable.
4. Update this document's status only after exact merged commit, tests, platform/model and observed results are known. Add chronological details to `CURRENT_RUN.md` without creating another architecture authority. Use §42 pins/licensing before importing algorithms or code.
5. Record unverified/unsupported paths, user-approved provider cost, CI status, resource baseline and owned worktree/process cleanup. Do not publish quantitative speed/RAM claims without raw reproducible evidence.

## Documentation-update validation status

**Historical initial pass:** this PR originally edited Markdown only. Later commits on this same branch added real Core ToolRegistry admission/registration checks, Rust PAUSED→UNKNOWN reconciliation handling, and Bun/Rust negative tests (see the newest entries below). The initial source/heading/Markdown-format pass did not exercise OS/backend tests. Final GitHub Actions validation must be checked on the **latest PR head**; no native Windows/macOS, provider inference or JCode-vs-Horizon benchmark is established by these source edits.

## Detailed HLD/LLD readiness reconciliation — 2026-10-15 (documentation-only)

All 46 `arch_V1/*.md` active and compatibility Markdown files were rechecked structurally for duplicate/out-of-order numbered sections, balanced code fences and escaped code literal artifacts. Authoritative product HLD is §01.13; function-level wiring and source paths §10.15/§20.12; machine schemas §12.16; shared-kernel IPC §13.12; runtime flow §15.20; resource budget/sampling/cache §18.18–19/§30.21/§37.17; worker/DAG §21.11/§29.18; TUI/UI §16.17/§31.17; SDK/import/steering/canary §37.19; fault cases §32.33–34. The operative plan RC0–RC5 now has a function-to-code-to-test ledger. Historical `opencode/` Markdown and `docs/architecture-archive/` are inherited/reference, not parallel implementation authority.

**Source truth:** current code remains narrow Linux Session supervisor + guarded file write, partial non-executing P2 admission state and initial feature-exposure UI. No new schemas, shared daemon, RAM benchmarks, provider doctor, headless worker or native Windows qualification were run or implemented by these Markdown-only commits. Earlier PR #7 CI failed on numbered architecture headings and mandatory provenance pointers; both documentation faults were corrected in branch commits. **Recheck latest final-HEAD Actions status before merging**, and do not mark the real runtime implementation tests as passed based on docs-only typecheck.

## Cross-document omissions confirmed on 2026-10-15

- Root `SECURITY.md` and `CONTRIBUTING.md` had inherited OpenCode disclosure/project instructions. They now describe HorizonCode and link to the upstream copies only for provenance. The separate upstream vulnerability reporting URL/email **must not** be represented as HorizonCode's reporting channel.
- The operative §§3.16–3.18 accepted external agent/native OpenCode, visual edit and deploy/verify/rollback user journeys, but lacked complete service/permission/candidate/test bindings. Their **DESIGNED / NOT WIRED** contracts now live in §§14.18, 20.13, 29.19, 33.30, 37.20–21 and test cases ACP-001..008, VIS-001..004, DEP-001..008 in §32.35. The pinned OpenCode ACP server is code present; the Horizon outbound ACP client was not independently verified.
- Source input at `docs/architecture-input/universal-software-agent-v2-source.md` now explicitly declares itself historical non-normative; its older internal “Normative precedence” text does not override current `arch_V1/` decisions.
- The root redistribution LICENSE file was not present in the reviewed tree. Release licensing/attribution remains an **OPEN** gate; no license was chosen or copied in this docs-only pass.
- These are documentation and implementation-contract corrections only: no deploy/ACP/visual backend, RAM measurement, shared kernel, or universal Guard execution was implemented by this branch. Recheck GitHub CI on the **final head** before merge.

## Final cross-owner contract pass — 2026-10-15 (documentation only)

Re-read all **23 normative numbered architecture owners**, the root agent/implementation/status guidance and operative checklist from the PR #7 branch. Cross-reference scanning identified a broken `§31.18` pointer in PF-004, corrected to the actual §31.3/§32.21 performance owners; no other missing references were found among this scanned set of numbered active owners. This does **not** establish a human semantic line-by-line audit of inherited/archived/source Markdown; earlier 779-file upstream inventory was incorrect (actual count 152 tracked upstream Markdown in the complete Git tree at `dc61b665`).

- **Real specification conflict fixed:** §18.18's four-state `WorkerResourceReservationV1` (`ACTIVE` etc.) disagreed with §11.20's Rust reservation lifecycle, and §11.20's `SOFT/HARD` pressure labels disagreed with §18.18. §11.20 now owns seven exact reservation states and the canonical `SOFT_PRESSURE/HARD_PRESSURE` labels, with no `UNKNOWN` reservation state. §18.18 and §12.16 use those exact names. Expiry may release capacity only when no worker/effect was launched; after launch, unresolved process/effect remains `QUARANTINED` until receipt/process reconciliation and confirmed release.
- **Service authentication hardened in the design:** §37.18 now requires trusted authenticated scope on FileTouch ingestion/query/invalidation, headless broker operations and paid/network Provider Doctor operations; input session IDs, epochs, queue tickets, spend grants and effect leases are not self-authorizing. §13.12's READY response is distinct from the actual attachment ACTIVE state; §21.11 uses the same reservation lifecycle.
- **Tests and coding instructions aligned:** §32.37 adds `JC-RES-012.H–L` for enum parity, ID/PID races, expired-before-launch versus quarantine, forged owner/file-touch/worker tickets and Doctor grant mismatch; the operative RC0/RC2/RC3 ledger and AGENTS/IMPLEMENTER_PROMPT point to them. Tests are **specified, not executed**.
- **Outstanding actual release work unchanged:** universal P1 no-bypass, P2 executing scheduler and independent final verifier, generated contracts, OS sandbox/process qualification, benchmark harness and real measurements, distribution license/notices, and final CI on the **new branch head**. Documentation review must not mark these verified or claim every source sentence semantically audited.

## Complete tracked-Markdown structural audit — 2026-10-15

The complete GitHub recursive tree at PR #7 baseline `dc61b665` (not truncated) contains **278 tracked `.md` files**, 3,473,581 bytes and 52,523 parsed lines: 46 `arch_V1`, 59 archived, 2 architecture input, 152 pinned upstream OpenCode and 19 other project/support files. The previous report of 904/779 is **incorrect**. All 278 Git blobs were retrieved and read for structural link/fence/merge-marker validation: the initial parser reported **no active-project broken relative links** and 62 non-normative/historical/upstream relative-link warnings, many to removed generated inventories or test fixtures. The old records are preserved for provenance; broken archive links are not promoted into active authority.

The frozen per-file Git blob/size/scope/flag ledger is `docs/audits/2026-10-15-tracked-markdown-structural-manifest.json`. The durable check is now `python3 scripts/architecture/audit_markdown_repo.py`, invoked by `scripts/architecture/run_push_gate.sh`, with optional `--json-report` to emit per-file SHA256 hashes, line counts and warnings. The manifest belongs to the immutable baseline, not any later head. This is a **structural audit**, not proof that 52,523 lines received human semantic adjudication or that absent backend methods are implemented. Source checks reconfirm `managed_control.rs` remains explicitly non-executing and Rust Guard currently does not cover every enabled mutation origin. Compiled machine contracts, effects/worker adapters, independent verification, RAM/OS tests and redistribution decisions stay open. **CI for the final new head must be checked**, and all verified status changes require runnable evidence.


## 2026-10-15 documentation-regression hardening (audit tooling, not V1 runtime)

The existing convergence validator now executes static DOC-001..010 regression guardrails for project security/contributor identity, archived-source precedence, ACP/visual/deploy traceability, reserved capability status, release/OS caveats and the operative plan. The tracked-Markdown validator DOC-011 additionally examines inline/reference-style/HTML relative paths, fences, numbered headings, UTF-8 and conflict markers at the current checkout. These checks must pass on the final head in CI. They do not prove all runtime fault scenarios, per-sentence semantic correctness of 278 files, native-platform release qualification, licensing, universal Guard, executing P2, or independent verifier acceptance. No status is promoted on the strength of this validation code alone.


## 2026-10-15 pinned source AGENTS instruction conflict

A fresh bootstrap can restore `opencode/**/AGENTS.md` into root package subdirectories. Those inherited source notes contain OpenCode-specific policies (upstream `dev` branch, blanket app restart ban, developer-private source path). Root `AGENTS.md` and `CONTRIBUTING.md` now explicitly distinguish package-local implementation advice from HorizonCode policy, and DOC-012 static validation checks those warnings. Preserve upstream SHA and verify inherited instructions against the current Horizon task/OS/capability before running a coding agent. This remediation is instruction/docs only, not Guard enforcement.


## 2026-10-15 — owner-log machine-schema divergence discovered

Source comparison found the design-only `arch_V1/contracts-v2/managed-event.schema.json` used PascalCase event names and `schemaVersion: 2`, not the active Rust OwnerLogV2 physical record (`format_version=2` with seq/time_ms/kind/data/previous_digest/event_digest) and current snake_case `ManagedCommand` subset (`schemaVersion=1` in record data). Marked it explicitly non-runtime and clarified §04/§12; DOC-013 static guard prevents accidental typegen from the incompatible prototype. Public managed API stays design-only until explicit migration/projection and TS/Rust fixtures. Contract test PATH was also made platform/user-portable (DOC-014). No persistent event encoding was changed, no data was migrated, no scheduler was implemented, and no runtime release claim was advanced.


## 2026-10-15 — root package licensing metadata corrected

The root private `package.json` declared MIT while root LICENSE/NOTICE were absent and docs marked distribution permission unresolved. Set the **private workspace** SPDX metadata to `UNLICENSED` pending explicit Horizon-authored code license choice and audited notices; **did not modify `opencode/LICENSE` or any copied upstream license**. DOC-015 static test now blocks contradictory metadata. This is a conservative source-build disclosure, not a release-license decision or a claim that redistribution dependencies are cleared.


## 2026-10-15 — Features/Experimental source-status correction

§16.15.1 previously stated the TUI and app had no Features/Experimental surfaces; that was true of the pinned upstream-only snapshot, **false for current HorizonCode first-party overlays**. Verified `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/dialog-features.tsx` registered as `horizon.settings.features` in TUI app, `packages/app/src/components/settings-v2/features.tsx` mounted by settings dialog, and limited config helper tests. Updated §16 and §20 to **CODE_PRESENT/PARTIAL** and added DOC-016 static source-status guard. Not FEAT-001..014 full behavioral PASS: backend source/lock/pending/API and cross-surface integration remain open.


## 2026-10-15 — acceptance IDs structurally reconciled

§32 currently defines 334 unique acceptance case rows before DOC-017 was added. Existing convergence validation now checks duplicate case IDs, a nontruncated catalog and FEAT-001..014 / JC-RES-001..020 / DOC-001..017 presence (DOC-017). These are source/inventory checks rather than executable tests or a completed P1/P2 negative coverage claim. Real test-to-function/source trace, platform matrix, integration and CI acceptance are still separate release gates.


## 2026-10-15 — first-party Core ToolRegistry effect containment slice

Code was changed (not merely docs): `packages/core/src/tool/registry.ts` now filters unsupported effect classes before advertising tools, refuses missing Rust admission at settlement, permits the narrow guarded `files.write` only via the Location-owned `write` registration and denies an `ApplicationTools`/plugin declaration claiming the built-in ID. Added real Bun regression fixtures in `packages/core/test/session-runner-tool-registry.test.ts` for unadmitted, unsupported and spoofed effects. `kernel/src/managed_control.rs` now moves a PAUSED Run to RECONCILING when its admitted Attempt turns UNKNOWN; an integration test asserts durable replay and unsafe resume denial. The **actual guarded write** has been promoted to `code_present` in the canonical registry only (CODE-001). Neither same-process malicious plugins nor shell/MCP/desktop/REPL effects are universally mediated; **P1.3 and P2 still incomplete** until whole negative/action/provider test set passes. Final SHA CI must be verified.


## 2026-10-15 — first Rust resource headroom calculator (pure CODE_PRESENT, not WIRED)

Added `kernel/src/resource_budget.rs` with one conservative typed ReservationState enum and exact-integer headroom math implementing §18.18 for JC-RES-012.C–G. Rust unit fixtures cover measured+reserved double-debit, unknown/stale owner sample retains full reservation, terminal vs pre-launch reserve, >2^53 and overflow-safe subtraction and UnknownCapacity. The push gate invokes `cargo test --lib resource_budget`; this is a **pure calculation** with no OS process sampler, no authenticated worker/resource lease, no Run scheduler connection, no platform support or RAM benchmark. Resource control stays CODE_PRESENT/PARTIAL until integrated OS/authorization/negative tests.


## 2026-10-15 — reservation transition negative tests (pure code only)

Added fail-closed `ReservationState::validate_transition` to `kernel/src/resource_budget.rs` plus pure Rust tests for JC-RES-012.H/J: EXPIRY requires proven never-dispatched, launched uncertainty cannot expire, QUARANTINED requires reconciled return, RELEASE requires process exit and settled receipts, and RELEASED/EXPIRED cannot revive. No runtime Rust lease owner calls the helper yet. Proof flags must be derived from authenticated process identity, receipts and expected owner epoch and committed atomically; tests of supplied flags do not establish those facts. Do not promote resource management to WIRED on this basis. CI on final SHA is required.


## 2026-10-15 — trusted first-party write provenance gate

Real P1 spoof gap found in Core registry: any local `Tools.Service.register` was previously able to claim `files.write`/`write`, be advertised and receive a caller-supplied `EffectAdmission`. Added `isTrustedWrite` first-party instance provenance in `packages/core/src/tool/write.ts` and require it at both Core tool materialization and settlement in `packages/core/src/tool/registry.ts`. This rejects forged Location tools even if they invent an effect challenge; added a negative integration fixture to `packages/core/test/session-runner-tool-registry.test.ts`. Trusted built-in write still independently resolves/approves/executes via Rust. The provenance WeakSet only protects the honest module registration API; a malicious same-process plugin/code with arbitrary JS execution can still circumvent the host boundary. Universal Guard remains incomplete; release requires untrusted origin process isolation, authenticated process/lease validation and negative coverage. Confirm final-head typecheck/Guard CI before merging.


## 2026-10-15 — remove provenance module cycle

Adjusted the previous write spoof mitigation to avoid `registry.ts -> write.ts -> registry.ts` module initialization loops: first-party provenance is now stored in `packages/core/src/tool/write-provenance.ts` with a WeakSet and separate marker/check methods. The built-in write leaf marks only its constructed decorated tool; registry's advertised/settlement routes consult the same set. This is **trusted-process provenance**, not a hostile same-process JavaScript sandbox; the exported marker remains accessible to arbitrary code loaded into the trusted process, so real untrusted plugin isolation and Rust effect mediation remain P1 release blockers. No claim of universal mutation safety or external effect handling.

## 2026-10-16 — next coding-agent execution handoff

**User-directed execution method:** use separate subagents for P0, P1.2, P1.3→P2, P3, P4 and P5. P1.3 and P2 belong to the same agent, sequentially; do not start P2 until P1.2/P1.3 prerequisites actually pass. The main agent owns source/reference research and integration. Do not serialize independent modules or use the main agent to rediscover architecture already recorded in `arch_V1/`.

**Source-reuse direction:** before implementing, inspect the active owner docs, the local pinned OpenCode source and the exact immutable OMP/OpenCode references in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md`. Prefer reuse or bounded algorithm adaptation over a new parallel implementation. Inspect callees, tests, licenses, exceptions and dependency closure; record any copied/translated source in §42. Upstream patterns never override HorizonCode's canonical Core/Guard/ExecutionHost ownership. Unsupported effect origins stay unavailable.

**Native Windows testing authorization:** the user authorized task-scoped Windows testing under `/mnt/c/users/sonali/desktop/`, using a newly created temporary directory with a child `hzcode` folder. PowerShell 5.1.26100.9711 is available at `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, and the Desktop path exists. No Windows test directory was created in this continuation. Create a unique task-owned directory; do not overwrite or remove existing Desktop content.

**Shared-tree safety:** at the `b9c9f46` status checkpoint: branch `p1.3-interactive-pty-integration`, 0 staged / 38 unstaged / 24 untracked paths; one registered worktree; 844 GB free; `kernel/target` 1.8 GB, `indexd/target` 69 MB, root `node_modules` 2.5 GB, and `packages/opencode/node_modules` 492 KB. The preceding six-path commit was `dd51d9e3050a853f46d273b55ce5fe3c22d245c1`; `b9c9f4656d182a97f47ac4e35d92c6b9e47a1d5f` recorded the gate/cleanup status. `git worktree prune --dry-run --verbose` found no stale registrations; no worktree was removed. Preserve the remaining shared dirty/untracked paths; no reset, clean, broad staging, or branch deletion.

**Current verification and limits:** workspace package audit passes at 36 workspaces / 0 undeclared / 0 errors; the PTY route is 1 pass / 4 skip and listener suite 9 pass / 3 skip. Markdown audit has 0 active blockers; convergence has 1,224 checks / 0 failures. The later mandatory `scripts/architecture/run_push_gate.sh` passed audits, kernel build, managed-control tests (10/10), and resource-budget tests (9/9), then failed at the Core TypeScript check with errors across Core and imported HorizonCode CLI-host package/session/server owners. This supersedes the earlier standalone no-diagnostic Core typecheck result. No native Windows acceptance, full P1.3 origin proof, or P2 managed vertical was run; no push occurred.

**Immediate handoff:** read this file, `CURRENT_RUN.md`, root `AGENTS.md`, `arch_V1/README.md`, `arch_V1/17-GOVERNANCE-DECISIONS.md`, and the operative plan. Inspect exact tree ownership. Then do the requested P0/P1.2/P1.3→P2/P3/P4/P5 subagent split with non-overlapping write scopes; keep the P1.3/P2 dependency sequential. Main agent must finish pinned-source reuse review before authorizing ports, and run shared integration gates only after module handoffs.

## 2026-10-16 — Git publication and worktree cleanup

The user requested merging subagent worktrees, committing and pushing, then pruning worktrees. The repository has only the current checkout registered as a worktree; there are no separate subagent worktrees or stale registrations to merge/prune. Other pre-existing shared changes remain untouched.

The six verified handoff/test/audit paths were committed as `dd51d9e3050a853f46d273b55ce5fe3c22d245c1` (`fix(test): correct PTY harness and workspace audit`); the status/cleanup record was committed separately as `b9c9f4656d182a97f47ac4e35d92c6b9e47a1d5f`. Both are unsigned because the configured GPG identity has no available secret key. `origin` had no `p1.3-interactive-pty-integration` branch; at the `b9c9f46` checkpoint, the local topic branch was 8 commits ahead of `origin/main`. No push occurred.

Push is blocked: the required pre-push hook runs `scripts/architecture/run_push_gate.sh`, which fails in the Core TypeScript check. Do not bypass the hook. Repair the recorded Core/OpenCode type errors and rerun the gate before pushing. The uncommitted remainder is 38 modified and 24 untracked paths; inspect ownership before staging. The root `.horizoncode-e2e-20261013` sandbox is not a Git worktree and was not removed.

## 2026-10-16 — local main integration status

**Current branch:** local `main` was fast-forwarded from `c47657ef5` to `243bd986d9ae9e06296a60463a92adb47615aa9c` (`commit`) from `p1.3-interactive-pty-integration`, with no conflicts. The tree was clean after integration. `main` is 10 commits ahead of `origin/main`; **nothing has been pushed**. The prior 38-modified/24-untracked status above is historical and superseded.

**Publication gate:** `bash scripts/architecture/run_push_gate.sh` on merged `main` passed source, package, convergence, Markdown and provenance audits; kernel build; `managed_control` (10/10); and `resource_budget` (9/9). It exited 2 at `tsgo --noEmit` due to unresolved Core/OpenCode/server/session TypeScript errors. Examples include `SessionSupervisorError` not fitting route error channels, incompatible PTY/shell-profile errors, and a stale `source` property in `packages/opencode/src/session/revert.ts`. **Do not bypass the pre-push hook.**

**Branch/worktree cleanup:** there is one registered worktree (the main checkout) and no stale worktrees. No worktree was removed. The user selected pruning only local `p1.3-interactive-pty-integration`, and only after a successful push. Keep it until then. Preserve local `p2-foundation` and all remote refs; three remote refs are not merged into main: `origin/docs/readme-product-first-20261014`, `origin/docs/readme-visual-first-20261014`, and `origin/fix/p1-3-streamed-tool-input-lifecycle`.

**Immediate next steps:**
1. Fix the owning Core/HorizonCode CLI-host package TypeScript contracts; rerun focused Core typecheck and the full push gate.
2. Push `main` only after the required gate passes.
3. After a successful push, delete only local `p1.3-interactive-pty-integration`; retain `p2-foundation` and remote branches. Verify status and worktree inventory.

**Resource check after gate:** 846 GB available; `kernel/target` 1.8 GB, `indexd/target` 69 MB, root `node_modules` 2.5 GB. No task-created worktree or service remains.

## 2026-10-18 — current resumed phase evidence

- **Tree:** preserved the existing staged/unstaged/untracked files on `main`; one worktree, no conflicts. Parent reran A4 after fixing hidden `api.ts`, `websearch.ts`, SDK generator, and new Goal-review handler paths. Audit passed at this point: `compared=6627 changed=246 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. Rerun after remaining source changes.
- **P1/P2 shared boundary:** `cargo check --locked --offline --manifest-path kernel/Cargo.toml --lib` passed after both owners wired the managed Attempt scope digest across HostKernel→Guard. P1 removed the Core Bash leaf's direct process implementation; `test/tool-bash.test.ts` passed 3/3 and the OpenCode origin/batch suite passed 71/0. A first 119/2 Core run used stale `hz-kernel`; rebuilding from current source made the exact deadline regression pass. Fresh interrupt returns `completed=false`, but the old pre-cancel PID assertion reads a PID from bubblewrap's namespace; a unique host-visible process marker fixture is pending. P1/P2 have landed the `EffectAttemptScopeV1::{Managed,Direct}` contract; direct child effects remain denied until HostKernel validates durable principal/workspace/permission/budget/revision facts and P1 binds the exact digest into the Guard lease.
- **P2:** still active and incomplete. Distinct reviewer, actual current workspace revision, independent verifier evidence, effect-intent recovery, Core→TUI E2E and fault cases remain unverified.
- **P4:** whole-phase owner `p4_lsp_dap_repl` is active. Updated focused suite passed `bun test --timeout 30000 test/lsp test/dap test/repl`: 204/0 (671 expectations). Broker/session records are being bound to authenticated owner/workspace/policy/sandbox state. Process/callback exposure remains fail-closed pending a stable typed P1 Guarded ExecutionHost API; no real-project OS journey is yet verified.
- **P5:** owner returned PARTIAL. Cascade/config and builtin/Brave/Exa Settings dialog are implemented. Verification: HorizonCode CLI-host package tests 23/23 (66 assertions), HorizonCode TypeScript package typecheck (`packages/opencode`) clean; dialog 1/1 (9 assertions), TUI typecheck clean; parent app command test 1/1 (7 assertions). `web.search.settings` now opens the dialog. `WEB_SEARCH_GUARD_READY=false`, and tests prove zero outbound requests. Remaining: P1's Guarded outbound HTTP/receipt/cancel contract, then real adapters and provider failure/429/exhaustion acceptance.
- **P6/S1 and P7:** queued behind the three live child slots (P1, P2, P4); assign whole-phase owners as slots free. P3/P8/P9 and final release checks also remain in the V1 ledger.
- No phase is VERIFIED/RELEASED; no staging, commit, push, cleanup, paid API call, or native Windows acceptance occurred in this checkpoint.

## 2026-10-18 — post-compaction continuation

- Current child roster is P1 (`p1_guard_resume`), P2 (`p2_managed_resume`) and P4 (`p4_lsp_dap_repl`); the three child slots are occupied. This supersedes older roster statements in the file. The shared tree remains preserved on `main` with 150 staged, 112 unstaged and 33 untracked paths; one worktree, no conflicts. No build/test process was found at the latest scan; P1 owns the next Cargo acceptance wave and P2/P4 coordinate the TS check.
- P1's rebuilt-kernel terminal deadline/cancel fixtures pass 2/2 (19 expectations). The former host PID assertion observed a bubblewrap namespace PID and was invalid. P1 is repairing an owner-loss cleanup fixture whose first assertion checked only `/proc/<pid>` and timed out; it is verifying exact argv identity/process state. No production change from that fixture is accepted yet.
- P2 reviewer boundary: a distinct authenticated ServerAuth principal delegated by Core is an acceptable reviewer identity channel only when it comes from trusted connection state and matches a durable assignment. Independent verification still requires a trusted run/result bound to the live workspace revision plus concrete artifact/test evidence. Keep finalization and executor unavailable until this proof passes.
- P4 focused LSP/DAP/REPL suite: 204 passed, 0 failed, 671 expectations. Effectful routes remain fail-closed until P1's Guarded ExecutionHost interface and Linux/WSL journeys pass.
- Next whole-phase owners on slot release: P6/S1 and P7, followed by P5 resumption once Guarded outbound HTTP is established. P3/P8/P9 and release/CI checks remain in the V1 ledger. No phase is VERIFIED or V1 RELEASED.
- P4's exact P1 blocker: the current Guard/EffectHost prepare/lease API is terminal-only; there is no generic non-PTY ExecutionHost dispatcher. P1 owns a shared supervisor contract for capability + host-resolved executable/profile + bounded args/env + cwd/workspace/Location + Attempt scope, with exact lease/snapshot checks before confined dispatch and receipt/UNKNOWN settle/recovery. P4 confirms it will not call `horizoncode-sandbox` directly or add a parallel launcher; all routes remain disabled.
- P1 latest current-source Cargo wave: library **196/196**, `effects_host_process` **10/10**, and authenticated `host_terminal_events_process` owner-loss case **1/1**. `host_terminal_process::interactive_lifecycle_requires_approved_guard_lease` initially failed because the fixture prepared one argument map and dispatched another command; EffectHost correctly denied the changed digest. P1 is correcting the fixture to dispatch the exact approved arguments and will rerun it. `tool_batch_guard_matrix` was not reached. This is not a production Guard defect based on current evidence.
- Follow-up: P1's focused `host_terminal_process` rerun is now **2/2 passed**. Both initial failures were fixture issues: changed approved launch payload and a literal `\\n` that combined commands (only 369 output bytes); exact prepared args and a real newline now verify approval and >2 MiB replay eviction. P1 found direct child Attempt still does not bind EffectIntent or propagate scope through child prompt→ToolBatch; it remains fail-closed and P1 owns completing/testing the path.
- P2 managed validation: current Cargo wave compiled, lib **198/198**, `direct_attempt_rpc` **8/8**. `hz_kernel_process` self-review denial fixture omitted `expectedRevision` and failed during parsing; P2 is fixing and rerunning the focused socket target. Do not claim its HostKernel revision/evidence regressions verified until the rerun reports exact results.
- P4 added trusted REPL output/status reference checks bound to owner, workspace, sandbox generation and capability ceiling; focused suite **205 passed / 0 failed / 686 expectations**, Prettier clean. Next shared package typecheck follows P2's focused Rust target.
- P2 repaired the `hz_kernel_process` fixture with `expectedRevision`; focused real-socket rerun passed **4/4**. Remaining managed_control/RPC/settlement counts need a clean follow-up after P4's current TypeScript check.
- P4 returned **PARTIAL** and released its slot. Evidence: LSP/DAP/REPL suite **205/0 (686 expectations, 10 files)**, Prettier clean, HorizonCode TypeScript package typecheck (`packages/opencode`) exit 0. REPL output/status refs now check authenticated owner, workspace, sandbox generation and capability ceiling. Remaining: P1 generic Guard/ExecutionHost dispatcher, supervised process/recovery journeys, LS-006/008 resource admission/eviction, OS negatives and real Linux projects; all effect routes stay unavailable. Resume same P4 owner after P1's contract.
- Current child roster: P1, P2, P6/S1. P6 has the whole provider/settings/Doctor/question/switching phase. P5/P7/P3/P8/P9 and final release gates remain in scope/queue.
- P2 corrected `hz_kernel_process` passes **4/4**; its prior library tests **198/198** and `direct_attempt_rpc` **8/8** passed. Managed control/RPC/settlement exact totals still need rerun. P2 now owns HostKernel atomic batch binding for direct-Attempt effect sets; P1 owns child prompt/ToolBatch scope propagation. Task is still denied pending this full contract.

## 2026-10-18 — current fast phase wave

- Child slots: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P2 currently owns the shared Cargo slot for the plural direct-Attempt effect binding suites. P4 and P5 have returned PARTIAL and resume after their P1 contracts; next queued full-phase owner is P7, then P3/P8/P9 and release gates remain in scope.
- P6 Provider Doctor offline group/handler are wired by the parent into the central API and handler registry. Focused offline inspection: `bun test --timeout 30000 test/provider/doctor.test.ts` → **4 passed / 0 failed, 14 expectations**. The route only accepts the offline bounded schema and invokes `inspectOffline`; catalog/full probes are absent.
- P6 source audit found FEAT-001..014 still blocked on config origin/requested/effective/source/lock/pending semantics. P6 now owns `packages/core/src/v1/config/feature-exposure.ts`, `packages/opencode/src/config/config.ts`, and associated tests. Full TUI/Doctor/provider acceptance and integrated typecheck remain open.
- Central API registration changed only `packages/opencode/src/server/routes/instance/httpapi/api.ts` and `server.ts`; route-level generated SDK/client and live route acceptance remain outstanding. Preserve the entire shared dirty tree; no staging, commit, push, cleanup, paid call, or release claim.

- P1 direct child propagation update: Task carries private DirectAttemptAuthority into child prompt; ToolBatch batches returned effect IDs into one P2 `bind_direct_attempt_effects` call before exposing outcomes; bind failure cancels and denies. The direct scope is threaded through Core supervisor/PTY prepare and write/patch/terminal RPC bodies. Focused new Core regressions: **2/2 passed**. Remaining: integrated Core/HorizonCode CLI-host package tests and typecheck; P2 current HostKernel/socket tests; enabled-origin no-bypass and cancel/restart/UNKNOWN recovery. Task remains unavailable. The separate generic non-PTY dispatcher remains a P1-owned P4 prerequisite and is not yet stable.
- A4 audit after central Doctor API registration and exact ignore exceptions: **`compared=6627 changed=246 hidden_changed=0 hidden_new_source=0 stale_unignore=0`**. Point-in-time only; rerun after all remaining phase source changes.
- P6 Doctor provenance correction: initial offline DTO echoed request-supplied `ownerRef`/`ownerEpoch`, contrary to §37.18's `inspectOffline(ref, auth)` contract. P6 agreed to remove these fields from the offline read-only projection and add a spoofed-identity negative test. The route remains authenticated and effect-free; do not treat its response as independent verification evidence.
- **P2 plural direct-effect contract evidence:** current-source Rust results: `managed_control_rpc` **11/11**, `direct_attempt_rpc` **10/10**, `managed_settlement_provenance` **4/4**, plus same wave `--lib` **198/198** and `managed_control` **9/9**. Initial red results were stale test fixtures, corrected to assert pre-dispatch no-write/no-retroactive-binding behavior. Live-socket wire matches P1: request `{attemptID, locationID, sessionID, effectIDs, directAttempt}`; response includes bound IDs, revision and refreshed scope; expectedRevision advances by one, actual workspace edits reject stale authority. This releases the Rust build slot but not P2 phase ownership. P2 still lacks an actual authenticated independent verifier and finalization stays disabled.
- P1 direct-child focused suite: `bun test test/session/tool-batch.test.ts test/tool/task.test.ts test/session/prompt.test.ts` → **115 pass, 1 expected V2-projector skip, 0 fail, 516 expectations**. P1 is adding Core supervisor RPC wire assertions and multi-batch/stale/forged scope negatives. P2 plural ManagedControl TS client suite: **23/23, 137 expectations**. Serialize one integrated package typecheck after the P1/P2/P6 edits and SDK generation stabilize.
- Parent P9 synthetic CLI launcher/installer tests pass **2/2**: both manifest names point to one launcher and forward arguments/exit status; local installer creates `horizoncode` and `hzcode` aliases in a temporary HOME. These use a fake candidate binary and do not count as real built-product startup or clean-install evidence.
- P1 integration review caught a real direct-scope wire mismatch: Core's typed `ownerEpoch`/`expectedRevision` were decimal strings, while Rust `DirectAttemptScopeV1::from_value` strictly accepts unsigned u64 fields. P1 owns checked numeric serialization at the Core HostKernel boundary and prepare/consume live regressions. The child-effect path is not WIRED/available until corrected and retested against real HostKernel.
- **Ruling — workspace rebase after direct child effects:** reject the suggested simple “settle receipts, hash current tree, issue new scope” refresh. It could bless concurrent human edits. Keep the admitted workspace revision immutable and deny later child effects after a revision change unless a future receipt contract proves the exact full tree delta came only from that Attempt, including terminal-process side effects. P2 minimum V1 proof is one guarded action; finalization stays blocked on independent verification. Cost if wrong: a legitimate child multi-action flow may require re-review/re-admission until precise receipt-derived workspace rebasing exists.
- P2 independent-verifier evidence depends on P7: `kernel/src/artifact_store.rs` is currently a private unwired seam, and P7 owns exact-ref bounded ArtifactStore integration. P2 should implement typed verifier assignment/evidence contracts and hard-false finalization now, then integrate with P7's immutable artifact fetch/verification API when available; do not create a duplicate store.

### Current continuation delta (2026-10-18)

- A1's sole product-facing gate is `bun run horizoncode:typecheck`; `scripts/architecture/run_push_gate.sh` invokes it once. The root command now runs the internal HorizonCode CLI-host package-derived CLI host, the separate TUI package, and Core. `packages/opencode` remains an internal source location under the staged migration decision in A-V2-27/§10.12, not the name of the product gate. Script syntax passed (`bash -n scripts/architecture/run_push_gate.sh`).
- Latest component diagnostics are not a combined HorizonCode gate run: the host leg has **eight diagnostics** in internal source under `packages/opencode`; P7 reports zero diagnostics in its changed files and removed the legacy debug-snapshot CLI path. P2 owns one test error at `test/server/httpapi-control-plane.test.ts:101` (`schemaVersion` literal widened); P6 owns seven SecretBroker/Secret Service/auth/schema diagnostics. The separately checked Core leg exits 2 with nine SDK/plugin-boundary diagnostics, none in P1's changed shell/terminal files. Rerun `bun run horizoncode:typecheck` after P2/P6 repairs; A1 remains IN PROGRESS until both legs pass together.
- P2 identified a Goal proposal atomicity gap: separate `create_goal` and `propose_spec` calls can leave a Goal without a SpecVersion. P2 owns the managed transaction and tests; P1 owns the narrow HostKernel `create_goal_proposal` dispatch. They are coordinating one schema, with caller identity derived from the authenticated IPC envelope, never from request JSON.
- P1's new IPC principal draft is out-of-body `authenticatedPrincipal: { kind: "server_auth", subject }`, optional so legacy/host-OS requests retain SO_PEERCRED-derived identity. Subject is bounded to 256 UTF-8 bytes and rejects control characters. HostKernel reviewer actions reject HTTP body identity and require the delegated principal to match a durable reviewer assignment; `effects.v2` remains fail-closed pending real-socket forgery, stale-principal, self-review and valid-review tests. The parent has authorized this direction from §§14.3/37 and requested exact schema/producer evidence before integration acceptance.
- P7's source-backed checkpoint-retention proposal restricts eviction to exact checkpoint refs with sole same-session ownership, journals oldest-first eviction intent before idempotent deletion, preserves shared blobs, and replays pending deletions after restart. P7 awaits the Rust slot after P1; meanwhile it continues independent P7 UI/replay work.
- Current active whole-phase owners are P1, P2 and P7 (all three child slots). P1 owns the next Rust validation slot; P7's latest typecheck has exited, and no Cargo/TypeScript process was present at the last check. Disk: C: `/mnt/c` has 26 GB free (95% used); WSL `/` has 815 GB free; existing `kernel/target` 12 GB, `horizoncode-sandbox/target` 140 MB, `indexd/target` 207 MB and root `node_modules` 2.5 GB. One registered worktree; no cleanup or pruning needed.
- Documentation checks after the current status update: Markdown audit **280 tracked / 0 active blockers / 62 reference-only warnings**; convergence **1,226 checks / 0 failures**; `bash -n scripts/architecture/run_push_gate.sh` and `git diff --check` passed. Overlay audit and the full push gate remain pending final integration. No commit or push was made.

## 2026-10-19 — resumed whole-phase integration

- Git MCP confirms local `main@6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind `origin/main`, with staged, unstaged and untracked files preserved; no conflicts. There are 160 unstaged and 70 untracked paths plus the existing staged set. One registered worktree only. No stage/commit/push or cleanup occurred.
- Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P7 remains queued until a child slot opens; P3/P4/P5/P8/P9 and final release acceptance also remain in the V1 ledger.
- Disk/process check: host C: (`/mnt/c`) has 25 GB free of 454 GB (95% used); WSL `/` has 815 GB free; `kernel/target` is 12 GB and root `node_modules` is 2.5 GB. No unknown worktree was removed or pruned.
- A1 interim evidence: `bun run horizoncode:typecheck` passed both the host and Core legs with no diagnostics after P6’s SecretBroker/Secret Service/auth/schema fixes. P1/P2 TypeScript integration has resumed, so A1 remains IN PROGRESS until the combined command passes again on the final integrated revision. The internal `packages/opencode` source directory remains under the approved staged migration; the product gate is HorizonCode-named.
- P1 focused test `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib builtin_verifier_challenge_revalidates_the_host_executable_profile_at_approval -- --test-threads=1` passed 1/1 after correcting three typed error conversions. Broker-process Guard/approval/lease/receipt wiring, origin closure and adversarial matrix remain open.
- P2’s new RED/GREEN state regression proved digest-only criterion evidence could previously finalize a Run; after the fix, finalization requires current typed `VerificationEvidenceV1` matching final revision/verifier with recomputed evidence digest. Focused test passes 1/1. This does not prove a real verifier process or full managed vertical.
- P6 focused tests passed: OpenCode auth/SecretBroker 7/7 (30 assertions), schema SecretBroker 5/5 (21), TUI provider options 5/5 (9). Whole-phase P6 acceptance remains open, including Provider Doctor, settings/provider journeys, S1 acceptance, entrypoint-level URL-login zero-effect proof and permitted free-model acceptance.
- Parent A4 audit returned exit 1: `compared=6627 changed=266 missing=1 symlink_delta=0 hidden_changed=2 hidden_new_source=3 stale_unignore=0`. Exact exceptions were added for the five existing hidden P7 files. The absent hydrated debug-snapshot source must be restored as a disabled/fail-closed path by P7; rerun A4 after P7 integration.
- Verifier ruling from §14.3: RunController-owned final verification uses `managed_run` and must not fabricate an Attempt; Task-attributable action stays bound to its live authenticated Attempt. Proposed verifier flow uses exact-set atomic approval resolution and yields all per-criterion one-use leases or none; output/token/artifact remain host-private until typed evidence and immutable ArtifactStore refs are validated against the current workspace revision. Finalization/fan-out remain disabled.
- C: has not decreased during these test/audit waves. No phase is VERIFIED/RELEASED; push gate, final cross-phase security/recovery checks, clean install and exact-scope publication remain outstanding.
- Parent mounted P6's offline Provider Doctor in the shared TUI app as `provider.doctor.offline` (`/provider-doctor`). RED/GREEN app integration: `bun test test/app-provider-doctor.test.tsx` → 1/1, 3 assertions; it confirms the command is discoverable, calls only the offline route, and makes no auth/provider request. A1 remains the combined `bun run horizoncode:typecheck` product gate and still needs final integrated verification.
- A1 command scope correction: `package.json` now makes `bun run horizoncode:typecheck` cover the internal CLI host, `packages/tui`, and `packages/core`; the prior command omitted TUI despite the documented gate scope. `run_push_gate.sh` already invokes this product command. The expanded command has not yet been run; await the serialized TypeScript slot and record its complete result.
- Verifier identity contract: authenticated begin must match the durable assigned reviewer; HostKernel selects an immutable verifier profile principal distinct from that reviewer and every Attempt executor, stores the profile principal in `Run.verifier_id`, and binds approval challenges to the reviewer. Caller-supplied verifier IDs are forbidden. P1 is implementing this boundary; launch/finalization remain unavailable until exact-group, process, receipt/UNKNOWN and recovery acceptance passes.
- P2/P1 approval bridge issue: transport loss or abort in a later ≤16-entry UI window currently drops genuine decisions from earlier windows. P1 owns a typed partial decision set plus terminal reason; P2 owns preserving it through the client and explicit HostKernel abort. Synthetic reviewer decisions remain forbidden; behavior is not verified.
- P2's new `packages/tui/src/component/dialog-goal-verification.tsx` was hidden by the root overlay rule; parent added an exact exception and Git MCP confirms it is visible as untracked source. `app.tsx` mount is deferred until HostKernel begin/resolve/execute and P2's current-workspace route are integrated and fail-closed.
- Quota-reset phase resume: P1/P2/P6 are active full-phase owners again. P1's `cargo test --lib verifier_ -- --nocapture` failed to compile before running tests with E0308 at `kernel/src/host_kernel.rs:2260` (`managed_phases` requires a borrowed snapshot); P1 is correcting it and will notify before rerunning Cargo. Separate earlier EffectHost/Guard focused checks passed 11/11 and 1/1. P2 awaits P1's exact managed verifier route/approval contract before exposing verification; P6 continues independent provider/settings work. Latest resource check: no build process active, C: 25 GB free, `kernel/target` 12 GB, root `node_modules` 2.5 GB.
- After P1's failed Cargo compile exited, P2 used the shared test slot: `cd packages/opencode && bun test test/session/managed-control.test.ts` → 30 passed / 0 failed (182 expectations). This is Core orchestration/fake coverage, not HostKernel execution evidence. P2's current adversarial approval-window cases remain to be run. P1 fixed the borrowed-snapshot mismatch and has started one notified focused Cargo retry; parent measured C: 25 GB free and confirmed no competing build before it started.
- A1 command scope correction: `package.json` now makes `bun run horizoncode:typecheck` cover the internal CLI host, `packages/tui`, and `packages/core`; the prior command omitted TUI despite the documented gate scope. `run_push_gate.sh` already invokes this product command. The expanded command has not yet been run; await the serialized TypeScript slot and record its complete result.
- P2/P1 approval bridge issue: transport loss or abort in a later ≤16-entry UI window currently drops genuine decisions from earlier windows. P1 owns returning a typed partial decision set plus terminal reason; P2 owns preserving it through the client and explicit HostKernel abort. Synthetic reviewer decisions remain forbidden; exact behavior is not yet verified.
- Verifier identity contract: authenticated begin must match the durable assigned reviewer; HostKernel selects an immutable verifier profile principal distinct from that reviewer and every Attempt executor, stores the profile principal in `Run.verifier_id`, and binds approval challenges to the reviewer. Caller-supplied verifier IDs are forbidden. P1 is implementing this boundary; launch/finalization remain unavailable until the exact-set, process, receipt/UNKNOWN and recovery acceptance passes.
- **Latest execution delta:** P1's current verifier filter passed 10/10 (239 filtered) after fixing an expiry-path borrow error. P1 owns next Rust wave and HostKernel exact-group/expiry tests; its process-launch and typed-evidence producers remain gated. P2 now adapts the managed caller to P1's typed partial-approval result and is assigned a separate read-only review of `/mnt/c/users/sonali/downloads/extra_some_Stuff.md` while waiting; after the caller edit, run the focused Bun suite, then return a source-backed accept/adapt/reject report tied to relevant arch_V1 sections. P6's latest focused suites: provider/Doctor/login/free 30+1 expected skip/114 assertions; settings 2/16; SecretBroker/Auth 9/35; TUI provider/model/Doctor 23/104; S1 7/38; FeatureExposure 12/56. No live provider request was made.
- Parent added an exact-pin Codex CLI/OpenCode subagent allocation and lifecycle comparison to `implementationtov1release.md`. Keep the Rust DAG/Task/Attempt manager canonical; current DAG/WorkerPool code is not production ingress or process launch. P1 owns pre-dispatch child authorization/Guard, P2 proves one managed Attempt and independent verifier, P8 remains queued as the whole-phase owner for durable worker/DAG/resource integration after a child slot frees and P1/P2 gates pass. Direct-session Task UI/ActivityStream evidence does not prove managed-worker progress/recovery.
- Child capacity is three and currently full (P1/P2/P6). No extra child/worktree was created. Host C: remains 25 GB free of 454 GB (95% used); `kernel/target` 12 GB. Keep one heavyweight Cargo/TS check at a time; P1's filter has exited, and P1/P2 must coordinate before the next Rust build. A1's expanded `bun run horizoncode:typecheck` covers CLI host + TUI + Core and still needs a post-integration run. Existing staged, unstaged and untracked changes remain mixed; no stage, commit, push or cleanup occurred.

### Resume manifest — 2026-10-19 latest

- **Owners and slots:** P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifact/automation/rewind are the three active whole-phase owners; P6 remains incomplete and queued. Parent owns integration, A1/A2/A4, release tracker, app-level wiring, exact ownership and final acceptance. Do not spawn above actual capacity. Next whole phase slot goes to queued P6 (or P8 if P1/P2 prerequisite evidence passes and critical-path review prefers it); P3/P4/P5/P8/P9 remain unfinished.
- **P1:** latest focused tests reported green: verifier filter 10/10; exact managed-run approval/preflight 1/1; aggregate output-cap test 1/1; HostKernel unit selector 24/24 after explicit `capability_unavailable` guards for approval resolution and identity-free aggregate execute. Execute accepts only `{goalID,runID,verificationRunID,challengeSetDigest}`; output token gained a capture timestamp accessor. `HostCapturedVerifierOutputV1` is private/non-cloneable but has no production mint path; `TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`. Continue real Guarded `managed_run` process/approval/lease/receipt/output mint, origin matrix, and cancellation/crash/UNKNOWN recovery; keep effects fail-closed.
- **P2:** latest focused route+approval suite: `bun test test/session/managed-control.test.ts test/server/httpapi-control-plane.test.ts test/server/httpapi-instance.test.ts` → 49 passed (243 assertions, 5.98s), including live-instance schemaVersion=2 rejection and approval/deny/partial/interruption. Repaired prompt/apply_patch/task/write fixtures: 72 passed, 1 pre-existing skip (332 assertions). Current-workspace verifier POST accepts only `{schemaVersion:1,goalID,runID}`; identity and workspace/location derive from trusted middleware/`InstanceState`; it returns no lease/evidence claims and maps unavailable P1 execution to `capability_unavailable`. Continue authenticated reviewer/Goal proposal path, real managed Attempt/revision/receipt/evidence, and pause/cancel/restart/UNKNOWN/stale/conflict recovery; do not expose finalization/fan-out.
- **P7:** implementing full P7; exact ArtifactStore handoff is by-value `HostCapturedVerifierOutputV1`, consuming into immutable refs only after P1 producer acceptance. P7 restored hydrated `packages/opencode/src/cli/cmd/debug/snapshot.ts` as an unregistered fail-closed marker, verified by parent source read and A4. Continue replay/resnapshot/large-history, artifacts, analytics, durable automation/recovery and checkpoint/rewind acceptance without effects before P1.
- **A4:** after exact parent-owned `.gitignore` exceptions and P7's restored unregistered fail-closed debug-snapshot marker, fresh audit exits 0: `compared=6627 changed=270 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. Rerun at final integration; do not add broad unignore rules.
- **A1/A2:** fresh integrated `bun run horizoncode:typecheck` exited 0 across CLI host + TUI + Core on a source-frozen snapshot; this is current-snapshot evidence, not final-head verification because P2/P7 resumed TS edits afterward. Rerun after their next stable boundary and in the final `bash scripts/architecture/run_push_gate.sh`. The prior reported push-gate pass is historical; A2 still requires the full final integrated run.
- **Guard approval UX gap:** `SyncContext.guardApproval.pending/reply` and `guard.approval.requested` are wired, but no rendered consumer exists. P2 owns a new standalone `DialogGuardApproval` and focused tests in exclusive component/test files; P2 also adds `app-guard-approval.test.tsx` as the red-first mount test; parent owns only `packages/tui/src/app.tsx`; P7 avoids these paths. Architecture §14.2 requires exact action/resources, argument summary, guarantees, policy/source, affected Run/Session, expiry and no-response behavior. The current event has host-minted target/policy/expiry/session fields but lacks some consent metadata. P1 audits/extends host projection; UI must mark absent context unavailable and never invent values.
- **Ruling — Guard allow needs assessed guarantees:** disable `allow_once` until host projection includes typed requested guarantees plus a typed residual assessment. A host-derived empty residual list is valid only after actual assessment; missing/`not_assessed` is deny-only. This preserves informed approval; cost if wrong: legitimate approval interactions stay blocked until the assessment path lands.
- **P1 Guard projection detail:** P1 confirms Guard receives requested guarantee strings and EffectHost persists origin kind, but current generic challenge lacks typed policy ID/source, safe argument summary and residual assessment. P1 owns bounded host-derived projection fields; verifier launch remains gated because there is no private managed_run launch/mint path. No client-supplied context may become authority.
- **P2 Guard approval UI progress:** red-first tests were added. First focused run: 0 pass/2 fail/1 import error; missing component is expected RED, while the app test assertion was masked by the empty-provider prompt. P2 is correcting the app fixture to seed a provider, then implement/test the component. Parent owns only app.tsx. Exact ignore exceptions keep test files visible; current overlay audit exits 0.
- **P7 ArtifactStore validation:** first integration-filter run failed the success fixture because it supplied an unbound `ReadPermit`; adapter rejection cases passed. P7 is fixing the fixture to obtain a store-bound permit through `authorize_read`, and will rerun with `--lib` after P1's Guard projection source stabilizes. This is test-fixture failure, not accepted ArtifactStore evidence.
- **External proposal note:** P2 completed the full `/mnt/c/users/sonali/downloads/extra_some_Stuff.md` review (1,851 prose lines plus embedded diagram); parent cross-checked `arch_V1` and recorded adopt/adapt/reject outcomes in `implementationtov1release.md`. Keep one Rust coordinator and current Guard/lease/evidence authority; no second daemon, untrusted policy source, universal performance claim, or production AST-splicer path was adopted.
- **Resources/Git:** C: `/mnt/c` 25 GB free of 454 GB (95%); `kernel/target` 12 GB, `horizoncode-sandbox/target` 140 MB, `node_modules` 2.5 GB. One primary worktree, no stale worktree entries. Preserve staged/unstaged/untracked work. User authorized exact-scope add/commit/push, but current ownership is mixed and gates are open; no stage/commit/push yet.
- **Release state:** PARTIAL. No phase verified, no final typecheck/push gate, cross-phase security/recovery matrix, clean install, legal/signing decision, native Windows acceptance or release publication. Continue phase owners; checkpoint exact source/test evidence and update this manifest before any stop.

### 2026-10-19 active continuation checkpoint

- Active whole-phase owners (all three child slots): P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifacts/automation/rewind. Parent owns `packages/tui/src/app.tsx`, integration, A1/A2/A4 and release gates. P6 and P3/P4/P5/P8/P9 remain queued. One primary dirty worktree; do not reset/prune/clean or stage broad paths. Latest host C: check: 25 GB free; `kernel/target` 12 GB.
- P1 Guard approval projection tests pass in Core 13/13 (73 expectations) and Rust 2/2. The request is bounded and host-derived; `allow_once` is disabled until a launch-specific sandbox preflight is retained and consumed against exact command/args/cwd/env/profile/executable/workspace/revision/owner epoch/backend facts. P1 owns `terminal_process.rs`, `effect_host.rs`, `host_kernel.rs`. Restart/stale, mismatch/replay, cancellation and zero-spawn-on-denial cases remain acceptance work.
- P2 approval component + Sync projection + parent app mount are source-present and the focused component/app suite reports 4/4 green. Deny is default, unassessed context cannot allow, and a complete assessed fixture uses a one-use decision. P2 continues all other managed vertical criteria: trusted distinct reviewer, live Attempt/effect binding, current final revision, independent immutable evidence, real socket, and pause/cancel/restart/UNKNOWN/stale/conflict. Finalization remains unavailable.
- P7's focused Cargo results: ArtifactStore 3/3, automation 16/16, checkpoint 7/7. These tests do not enable production effectful automation/restore. P7 is implementing monotonic source sequence/generation through schema→emitter→TUI, with gap-triggered resnapshot, and ArtifactStore must refuse unknown-redaction verifier output. P1/P7 are coordinating host-safe manifest evidence; raw output is never published.
- Overlay audit after exact ignore exceptions: `compared=6627 changed=272 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. It must be rerun on final integrated source. The latest integrated `horizoncode:typecheck`, push gate, final architecture/release checks and real Linux/WSL end-to-end journeys remain open. No stage/commit/push occurred; user authorization remains limited to exact verified task-owned changes after ownership and gates are resolved. Native Windows is still unaccepted.
- Structural tracker checks on this checkpoint: Markdown audit passed (280 tracked files, 54,906 lines, 0 active blockers; 62 historical/reference warnings); convergence validator passed (26 schemas, 205 catalog IDs, 225 registry IDs, 1,226 checks, 0 failures); `git diff --check` passed. Rerun on final integrated revision.


### 2026-10-19 continued execution

The live roster supersedes older owner summaries: P1 Guard/ExecutionHost, P2 managed vertical, and P8 resources/workers are active. P7 is partial and queued to resume; P6, P3, P4, P5, P9 and final release acceptance are still open. P8's authorized Rust wave exited 0 (`--lib` 263/263; all six selected integration targets exited 0, exact combined count unavailable due truncated output) and RC0 Python tests passed 48/48. P8 found stale/mixed-generation `TouchedFileV1.source_revision` can pass TaskGraph delivery validation; P8 is next for one focused Cargo RED/GREEN correction. P1 then passed `verifier_challenge_retention_tests` 2/2 with active challenge-set reuse bound to immutable profile ID/principal/profile/executable/sandbox digests; its production verifier launch/output token mint remains unwired and restart/UNKNOWN recovery is open. P2's forged body principal was rejected before dispatch: `bun test test/server/httpapi-instance.test.ts -t 'rejects host_os Goal verification before managed snapshot dispatch'` → 1/1 (2 assertions), typed 403.

Parent integration checks: overlay audit `compared=6627 changed=272 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` passed. Git MCP: `main`, 150 staged / 165 unstaged / 83 untracked, no conflicts. C: 25 GB free; `kernel/target` 12 GB; root `node_modules` 2.5 GB. Preserve mixed ownership; no broad stage, commit, push, cleanup, or prune. Re-run `bun run horizoncode:typecheck`, overlay/architecture audits and full `scripts/architecture/run_push_gate.sh` only after final integrated source stabilizes. V1 remains PARTIAL; no native Windows result is claimed.


### Phase handoff — 2026-10-19

P8 returned PARTIAL and released its slot after finishing independent work. Its TaskGraph file-touch source-revision check passed RED/GREEN 0/1→1/1; the full P8 Cargo command exited 0 (`--lib` 263/263; selected target counts truncated) and RC0 Python 48/48. Remaining P8 work depends on P1/P2: authenticated worker ingress/launcher, real guarded effect receipts, authoritative generation-bound conflict observations, real 1/5/10/20 session measurements; keep fan-out closed. P2 has the next one Rust writer/build window for the narrowly fenced same-verifier/same-final-revision retry after owner restart when Run is `Verifying` but no evidence exists. P1 is source-only in `host_kernel.rs` while P2 edits `managed_control.rs`; do not compile during concurrent Rust writes. P6 is now the third active whole-phase owner for provider/auth, Settings/FEAT, Provider Doctor, model switching, diagnostics and S1 question.ask. P7/P3/P4/P5/P9 and release remain open/queued.

P1's latest origin audit found direct child-process Git mutation/network entry points in `packages/core/src/git.ts` (`clone`, `fetch`/`fetchBranch`, `checkout`, `reset`, and branch/commit/push candidates). P1 owns exact caller/test review and must either mediate with the canonical authenticated Guard/ExecutionHost or fail closed before any process/network effect with zero-effect regression coverage. Read-only Git remains available where source proves it is read-only.

P2's restart retry regression is now green: RED 0/1 then `verification_can_rebind_after_restart_only_without_current_revision_evidence` 1/1. The narrow rule permits a fresh verifier challenge only for a `Verifying` Run with the same actual current revision and assigned verifier, no typed or criterion evidence, all Tasks settled, no UNKNOWN and no active Attempt. Durable reopen preserves Run/revision/verifier/evidence history and creates no lease or Attempt; evidence-bearing same-revision retries remain rejected. P2 released the Cargo slot; P1 owns the next single retention selector after process/disk check.

P1's initial Bun invocation for a new origin regression failed in test setup (`await` inside synchronous `Effect.gen`); no test executed. P1 owns the fixture correction (`Effect.promise`) and waits for P6's active Bun suite before rerunning. This is not a product failure/pass.

P6's current provider suite has four Cloudflare OpenAI passthrough failures: host `OPENAI_BASE_URL` redirects the gateway wrapper's native OpenAI URL, so `openai.responses` is rejected before transport. Native Anthropic/Workers routes pass; P6 is fixing the endpoint binding and adding a Provider-service regression. No external network was used. P1's verifier-retention selector is in progress for zero capacity and UNKNOWN preservation; do not start another Cargo wave.

### Quota-reset continuation — 2026-10-19

Previous P1/P6/note-review workers hit usage limits; their shared-tree edits/findings remain preserved, and no phase is accepted complete due to that interruption. Fresh whole-phase owners now occupy the three child slots: P1 Guard/ExecutionHost, P3 RepoIntel, and P6 providers/settings/Doctor/S1. P1 is diagnosing the 20s real Guarded VCS apply timeout without weakening the assertion; arbitrary Git subprocess origin closure remains P1. P3 continues independent index/adapter work; its proposed bounded chunked HostKernel interface is not approved or wired, and HostKernel remains parent/P1-owned. P6 continues FEAT-001..014 including Core V2 next-turn config bridge, provider/model support, sealed skill IDs, Doctor and S1; effectful Doctor remains unavailable pending P1 Guard. P2 remains PARTIAL and must resume when P1/P7 evidence permits the single managed vertical. P7/P4/P5/P8/P9 and final release gates remain open.

Parent removed disconnected Goal-review stubs/tests while retaining live Core-to-TUI inbox/proposal and component behavior. The focused TUI selectors passed 7/7 (46 assertions) after cleanup; baseline was 9/9 (55 assertions), including the two tests for the disconnected stub. C: had 25 GB free; kernel target 12 GB; node_modules 2.5 GB. Preserve mixed Git state. Re-run overlay/Markdown/convergence checks after owners settle, then `bun run horizoncode:typecheck` and `scripts/architecture/run_push_gate.sh` on the integrated revision. No staging/commit/push; V1 remains PARTIAL.

P1's verifier-retention selector completed RED/GREEN: RED had 2 failures (empty-set capacity zero and UNKNOWN treated as evictable); GREEN `verifier_challenge_retention_tests` passed 3/3. Only Aborted/Settled sets may be pruned; profile ID/principal/profile/executable/sandbox digests and live reviewer/epoch/spec/revision/state are bound. P1 released Cargo. P2 owns the next single Rust slot for a typed `verification_evidence` negative case on the clean same-revision restart retry.

P1 confirmed `@opencode-ai/core/git` (GitV2) has only test callers; production routes use a separate VCS service. It is adding a fail-closed zero-process/no-filesystem-change regression for GitV2 mutations, with the harness syntax now corrected. Run after P6's active Bun suite; no test result yet. Do not conflate that closure with direct Guarded VCS apply, which still needs P1 real-socket proof.

P2 added the typed-evidence same-revision retry denial test; after correcting a test-only identifier compile error, exact lib selector passed 1/1 (266 filtered). It confirms evidence-bearing retry conflicts without mutating Run state.

P6 bound the Cloudflare provider to an explicit native OpenAI baseURL. Focused gateway tests now pass 14/14 (42 assertions), no external network. The broader provider/auth/config/S1 suite is 891 passed, 1 existing skip, 6 failures before accounting for the four newly fixed Cloudflare cases; two DigitalOcean legacy provider-router expectations remain to be resolved without bypassing P1 effect-origin controls. P6 has a narrow Settings pending-state test in progress; P1's Git-origin Bun test waits for the JS slot.

### Quota-reset continuation — 2026-10-19

Prior P1/P6/note-review child turns hit usage limits; their source edits and findings remain preserved, and none is treated as a completed phase. Fresh whole-phase owners occupy the three child slots: P1 Guard/ExecutionHost, P3 RepoIntel, P6 providers/settings/Doctor/S1. P1 is debugging the 20s real Guarded VCS apply timeout without weakening the test. The follow-up source audit found no exposed arbitrary Git subprocess API: production Git has only typed methods/private fixed-command helpers, and test setup uses a test-local subprocess helper. P1 is preserving those paths and fixing the fixture's approval-fiber error propagation to expose the actual apply result.

P3 has approval for an inert indexd library upload-staging primitive only: bounded chunk/offset/digest/TTL/abort/commit checks, no filesystem or runtime wiring, no caller authority, and no production route. The proposed HostKernel upload/query contract remains pending and parent/P1-owned. P6 owns provider/settings/Doctor/S1, including the disjoint Core V2 config and runner boundary and immutable skill identity. Effectful Doctor and all dependent paths remain disabled pending Guard evidence. Parent removed disconnected Goal-review stubs and their misleading mount tests; live TUI selectors passed 7/7, 46 assertions.

Latest audits: overlay `compared=6627 changed=275 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; Markdown 280 files / 55,041 lines, zero active blockers (62 reference-only warnings); convergence 26 schemas / 205 catalog IDs / 225 registry IDs / 1,226 checks / zero failures; `git diff --check` clean. C: 25 GB free; `kernel/target` 12 GB; root `node_modules` 2.5 GB. Mixed staged/unstaged/untracked tree remains preserved. Final HorizonCode typecheck, full push gate, remaining phase acceptance and safe ownership-bound publication are still open; V1 is PARTIAL.

### Quota-reset continuation update — 2026-10-19

P1 fixed the missing single-call Core consent projection for `session_batch/core.tool_batch`: focused RED/GREEN passed 1/1 and `cd packages/opencode && bun test test/project/vcs.test.ts` passed 14/14 (26 assertions), including real Guarded apply/stale-preimage behavior. This does not complete P1. P3 has a RED regression for duplicate `resolveProfile` invocation and is queued behind P6's shared Bun slot; its HostKernel bridge remains unapproved/unwired and symbol/reference/write-fence work remains. P6 SkillV2 files are now explicitly visible via narrow parent-owned `.gitignore` exceptions. Overlay audit is green (`compared=6627 changed=278 hidden_changed=0 hidden_new_source=0 stale_unignore=0`); Markdown 280/55,063 with 0 active blockers, convergence 26/205/225/1,226 with 0 failures, workspace audit 36/0, bootstrap 6,629 existing/0 missing. C: remains 25 GB free; WSL `/` 815 GB free; kernel target 12 GB, sandbox target 140 MB, node_modules 2.5 GB. One worktree; mixed Git state preserved; no stage/commit/push/cleanup. V1 remains PARTIAL pending whole-phase completion, final HorizonCode typecheck, full push gate and release acceptance.

### Phase-owner findings correction — 2026-10-19

Correction to the prior update: `resolveProfile` is already called once; the regression test is present but not yet rerun, so no RED is established. P3's borrowed upload-token boundary test passed 1/1 after validating 16..=64 bytes before copy. The proposed HostKernel bridge remains unapproved: TypeScript must not construct Rust `GenerationPack` bytes; parent will reconcile an embedded Rust scoped builder with §30.7/§30.10/§30.22 before any wire work. P3 also found catastrophic-backtracking risk in synchronous native regex under the 64 KiB line cap; deadlines/cancel must remain enforced through bounded isolation or a linear-time engine. ArtifactSearch has no product caller/registration yet; P7 owns that integration when scheduled.

P1's corrected kernel test `cd kernel && cargo test --lib terminal_run_command_rejects_nul_before_effect_admission -- --nocapture` passed 1/1 (267 filtered); the prior unqualified selector matched zero tests and only built targets. P1 found config-load detached `npmSvc.install(@opencode-ai/plugin)` despite disabled external plugin execution. P6 confirmed it does not own `packages/opencode/src/config/config.ts`; P1 now has exclusive ownership to remove/disable this origin with zero-process evidence. P1 also found post-admission Task cancellation gaps on metadata/promptOps/background-start failures and continues its full source audit. Keep all other effectful unsupported origins unavailable.

### Quota-reset continuation — current active owner evidence (2026-10-19)

**Roster:** P1 Guard/ExecutionHost, P3 RepoIntel, and P6 providers/settings/Doctor/S1 are the three active whole-phase owners. The Bun slot is currently with P6 after P1's focused provider regression. P2/P7/P4/P5/P8/P9 remain queued or partial; start a whole-phase owner as a slot frees. Parent owns cross-phase interfaces, status, A1/A2/A4 and final integration.

**New evidence:** P1's external provider test passed RED/GREEN; current GREEN command `cd packages/opencode && bun test test/provider/provider.test.ts -t 'unbundled npm provider is unavailable without install or import'` → 1/1, 3 assertions, 103 filtered. It proves config-supplied non-bundled npm provider code does not install or import. P3 ArtifactSearch suite → 18/18, 106 assertions; regex isolation → 2/2, 11 assertions; RepoIntel profile → 1/1, 2 assertions. P3 added a safe 60,000ms duration ceiling and a `Number.MAX_SAFE_INTEGER` regression; rerun it after P6 releases Bun. No claim of P3 phase completion.

**RepoIntel blocker:** no production HostKernel service/operation/caller is present. HostKernel's authenticated principal and Location→canonical-root/workspace mapping exist, but there is no per-principal read ACL/policy owner. The target §12.7/§30.22 binding must be implemented from trusted host state; TS-supplied principal/root/workspace/revision/policy cannot authorize a query. P3 continues adapter-side negatives and inert staging only; P1/parent must define and verify the HostKernel read-scope seam before production query enablement.

**A1:** authoritative product command is `bun run horizoncode:typecheck` (CLI host + TUI + Core); the operative plan wording was corrected on 2026-10-19. The command has not been rerun on final integrated source. A2 full push gate, final A4 overlay audit, integration/security/recovery acceptance, Linux/WSL journeys and clean-install/release gates remain open. `CURRENT_RUN.md` has the detailed current resource/Git snapshot. V1 remains PARTIAL; do not declare VERIFIED/RELEASED or publish mixed ownership.

### Active-phase follow-up — 2026-10-19

P6 SkillV2 loader/guidance tests passed 8/8 (49 assertions). P6 found and fixed FEAT-014 runtime behavior: the Core V2 compaction settings helper returned base settings without overlaying the new per-turn `auto/prune` snapshot. Its new N/N+1 runner regression pins settings through same-turn tool continuation, applies them next turn, and verifies model/provider selection remains unchanged. P6 is running the Config snapshot and focused runner suite; do not claim the fix verified until it exits green. Parent exposed `packages/core/test/config/turn-snapshot.test.ts` and its directory in `.gitignore`; `packages/schema/test/skill.test.ts` is also visible.

P1 now has cancellation cleanup for Task setup failures after durable Attempt admission, including bridge setup, `ctx.metadata`, missing `promptOps`, and background extend/start/promotion metadata. RED/GREEN is still pending its serialized Bun slot after P6. P1's separate external-provider zero-install/zero-import test passed 1/1 (3 assertions). P3 has added forged RepoIntel scope and stale-search-write boundary tests, pending the same Bun slot. P3 must leave the backend unavailable until P1/parent's authenticated Session/Attempt + Location/workspace + Core `PermissionV2` policy-snapshot grant is implemented and verified in HostKernel. Full A1/A2/A4 and phase gates remain open.

P6's first FEAT-014/SkillV2 verification wave passed Core skill/guidance 8/8 (49 assertions), schema Skill identity 3/3 (9 assertions), and Config + SessionRunner 98/98 (338 assertions). Its focused `tsgo --noEmit` is red on P6 source/test typing (Config snapshot FS error, Skill identity/type export, compaction `prune` narrowing), plus P1 HostKernel/Git fixtures and an OpenCode storage diagnostic under ownership review. P6 is fixing its own paths source-only. The shared Bun slot goes to P1 for Task post-admission cancel and GitV2 zero-effect regressions, then P3 boundary/timer tests. C: now has 22 GB free; `kernel/target` 12 GB, `node_modules` 2.5 GB; no test process was visible. Keep one heavyweight build at a time.

P1's Task post-admission setup cancellation suite is green: `cd packages/opencode && bun test test/tool/task.test.ts` → 14/14 (110 assertions). The owner is adding one extra `onPromote` metadata-failure regression and must rerun that file before accepting the delta. The existing GitV2 zero-process test lives at `packages/core/test/git.test.ts`, selector `refuses unguarded Git mutation and network origins before dispatch`; P1 will verify it after P3 releases Bun.

P3's RepoIntel forged-authority/stale-reference boundary selector plus ArtifactSearch timer-clamp selector passed 2/2 (8 assertions); full ArtifactSearch suite passed 19/19 (108 assertions), covering bounded worker regex deadline/cancel. These are focused evidence only; RepoIntel has no production HostKernel backend/caller. P3 retains phase ownership and continues source-only independent work while P1 uses the next Bun slot.

P1's latest Task cancel test caught duplicate cancel RPCs in the `onPromote` metadata-failure path; a cancellation-request fence fixed it. RED/GREEN selector passed 1/1 (7 assertions), then full Task test file passed 15/15 (117 assertions). Core GitV2 zero-process regression passed 1/1 (3 assertions), including no mutation process calls and no clone/create/worktree target. No whole P1 acceptance claim. P6's remaining checklist also includes real offline Doctor TUI, auth/cost/capability provider matrix and free-model 200/coding journey (with 429 truth), FEAT-001..014 source/lock/apply/cancel parity (Core V2 prune still absent), S1 mixed-effect/spoof checks, model switching TUI and V1/Core skill identity parity. P6 is using the newly released Bun slot for Core typecheck repair; P3's focused suites are green and waits for its next slot.

### 2026-10-19 — latest quota-reset handoff

**Roster / allocation:** P1 Guard/ExecutionHost, P2 managed vertical and P6 provider/settings/Doctor/S1 now occupy the three available child slots. P3 finished its independently executable phase work and released its slot **PARTIAL**; next queued phase is P7, subject to P1 Guard prerequisites for effectful artifact/rewind integration. P4/P5/P8/P9 and release remain open. Parent owns cross-phase integration and final gates.

**New exact evidence:** P1 rebuilt `hz-kernel`; the actual shell-interpolation selector passed 5/5 (30 assertions), including approved execution and redaction/no-secret assertions. HostKernel safe-summary tests 2/2; host terminal process tests 2/2; Core typecheck passed; Core launch+Git 21/21; Git tests 7/7. P1 is still working on all remaining Guard/origin/confinement/ToolBatch/adversarial requirements, including a fail-closed redactor case for credential-like quoted literals. P3 focused cache/watcher tests passed 13/13, watcher lib 8/8, and full offline indexd suite passed (lib 73, generation store 7, persistence 8, RepoIntel 5, transport 9, upload 9, watch 6; no failures). P3 evidence is in `indexd/src/README.md`; Gate 4 remains PARTIAL pending authenticated HostKernel/read-scope, supervised walker/watch, LSP, profile/resource admission and real large-project acceptance.

**P6/P2 boundaries:** P6 is implementing Linux Secret Service persistence, protected in-process TTY one-use input, broker lease consumption and native request transport in its non-overlapping P6-owned files. Credentialed routes stay unavailable until durable storage, request binding/revocation, zeroization and no-leak evidence pass. P2 owns the entire one-Attempt managed flow; its effectful path remains gated by P1 and it may proceed now on non-overlapping API/TUI/schema adapters. No worker fan-out/finalization.

**Workspace/release:** C: `/mnt/c` free 24 GB; kernel target 12 GB, indexd target 269 MB, node_modules 2.5 GB. One worktree, main at `6c8c5ab9a`, 12 ahead/0 behind; mixed staged/unstaged/untracked ownership and no conflicts. `git diff --check` clean. No stage/commit/push/cleanup. V1 is PARTIAL. Required next gates: finish P1/P2/P6 and remaining requested phases, then final `bun run horizoncode:typecheck`, overlay audit, `scripts/architecture/run_push_gate.sh`, integrated Linux/WSL security/recovery journeys and release/clean-install evidence. Native Windows remains unavailable absent native acceptance.

**P1 redactor and P2 re-entry update — 2026-10-19:** P1's new quoted-credential shell-summary negative completed RED/GREEN; `cargo test --manifest-path kernel/Cargo.toml --lib terminal_command_consent_summary -- --nocapture` passed 3/3. Quoted credential/Bearer-like literals fail closed, unquoted sensitive values redact, env values are omitted. P1 released Cargo and continues source-only. P2 reloaded whole-phase sources: verifier execution/evidence remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE: false`); typed Core→TUI Goal/review flow exists and has principal/revision assertions. P2 is auditing/implementing remaining one-Attempt work and now owns the sole focused Cargo window. No final managed acceptance is claimed.

**A4/P2 follow-up — 2026-10-19:** parent exposed exactly `packages/opencode/src/storage/`, `packages/opencode/src/storage/storage.ts`, P6 secure-input source/test and P3 generation-store test. Fresh overlay audit passes `compared=6627 changed=284 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` clean. P2 current Rust selectors passed typed-evidence retry 1/1, managed-control RPC 12/12, settlement provenance 5/5. Distinct reviewer/pause/cancel/stale/UNKNOWN/current-workspace/receipt negatives are covered in those selectors, but real verifier execution/evidence remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`). P2 is drafting an exact HostKernel seam and must not edit P1 shared files before ownership is resolved. P6 added echo-disabled bounded TTY bytes and a process-local one-use vault plus a RED lease-consumption regression; the credential route remains unavailable pending durable Secret Service + request-bound lease/revocation/zeroization tests.

**P2 verifier boundary ownership (2026-10-19):** P1 released exclusive `kernel/src/host_kernel.rs` to P2 and will not edit it during the lease. P2 owns that file and its verifier orchestration/tests; P1 retains `effect_host.rs`, `guard.rs`, `terminal_process.rs`, and sandbox backend, and must provide a typed Guarded launch/result seam. P2 must not use direct process dispatch, caller-provided evidence, or test-only artifact tokens in production. P1 can resume the RepoIntel read-grant seam after P2 returns HostKernel ownership to the parent. P2 current TS evidence: managed-control 34/34 (196 expectations), httpapi-instance 10/10 (30); Rust evidence: retry 1/1, managed RPC 12/12, settlement provenance 5/5. These validate state/client/security boundaries only; verifier execution/evidence remains unavailable. P2's required immutable invocation binding, actual final-revision checks, ArtifactStore provenance/revalidation and UNKNOWN/no-replay contract are recorded in CURRENT_RUN.md.

**P6 secure input / P1-P2 dispatcher update — 2026-10-19:** P6 fixed a byte-buffer alias bug in one-use secure input: cleanup zeroized a `Buffer.slice()` view, so ownership now transfers through a standalone `Uint8Array`. Exact secure-input + SecretBroker + DigitalOcean suite passed 16/16 (57 assertions); auth selectors 2/2, DigitalOcean 5/5. Credentialed routes remain disabled pending durable store and Guarded transport. P1 found the verifier lower-layer mismatch: stdio admission accepts `builtin.verifier`, but settlement reconciliation only accepts `TERMINAL_RUN_ID`. P1 owns the typed `effect_host.rs` reconciliation seam; P2 owns `managed_verifier.rs`/tests and exclusive `host_kernel.rs`. No verifier dispatch until immutable invocation bindings and receipt/UNKNOWN recovery pass. P1 now owns the serialized Bun slot for focused current-tree selectors.

**Exact P1/P2/P6 interface allocation — 2026-10-19:** P2 uses a private nested `host_kernel::managed_verifier` module (P1 confirms no `lib.rs` edits) and owns verifier invocation/orchestration plus its exclusive `host_kernel.rs` lease. P1 owns the confined `EffectHost::execute_managed_verifier` wrapper and recovery in `effect_host.rs`, using `StdioExecutionSupervisor` and the opaque P2 invocation; generic terminal reconciliation stays terminal-only. No dispatch until both layers and crash/cancel/UNKNOWN tests pass. P6 may exclusively edit `packages/llm/src/route/auth.ts`, `route/transport/http.ts` and route tests for one-request SecretBroker auth. DEC-V1-06 constraints remain: no general RPC/config/env/child/plugin/log/artifact transfer; transient auth only within one dispatch callback, no return/store/log, wipe source bytes, and retain UNAVAILABLE if runtime behavior cannot be verified. P1's current Bun suite is the single active JS test wave.

**Provider test correction — 2026-10-19:** P1's shared Task/VCS/provider suite reported 132 pass / 1 fail. P6 traced the failure to an obsolete test at `provider.test.ts:2186` that writes plaintext `auth.json` and expects paid OpenCode models. DEC-V1-06 requires legacy plaintext reads to fail closed, so P6 will update the assertion to verify denial/no-echo; do not re-enable plaintext Auth. P1's terminal-run-live Bun suite remains active and owns the slot until it exits.

**P1/P7 snapshot origin ruling — 2026-10-19:** P1 found `packages/opencode/src/snapshot/index.ts` still starts direct `git` processes (`init/config/add/write-tree`, `gc`, snapshot tree/diff) through `AppProcess.run`, reached by SessionRunner/Revert. Parent ruling: P1 temporarily owns that exact file and direct tests to fail closed before any process, expose typed UNAVAILABLE and prove zero spawn; no repo mutation. P7 gets the file lease back for guarded checkpoint/rewind integration. Cost if wrong: the feature stays unavailable until P7 implements Guarded mediation. This closes the direct process bypass without claiming checkpoint/rewind complete.

**P6 transport checkpoint — 2026-10-19:** request-scoped auth transport tests pass `packages/llm test/auth.test.ts` 8/8 (23 expectations): Authorization is absent from prepared headers, materialized only at HTTP dispatch, and dispatch runs once. Updated legacy plaintext auth fixture passes 1/1 (5 assertions), proving plaintext `auth.json` cannot unlock paid models; Auth was not weakened. Bun released. Durable Secret Service, lease/revocation, zeroization/no-leak and real selected-provider response/coding journey remain open.

**P2/P6 latest evidence and A4 — 2026-10-19:** P2's immutable `host_kernel::managed_verifier` contract compiled and focused unit tests passed 2/2; it binds canonical approval/invocation digests and validates observed-vs-UNKNOWN results, but dispatch remains disabled. P1 is implementing the EffectHost-only guarded wrapper. P6 `packages/llm` auth + route tests passed 9/9 (28 expectations), proving no prepared Authorization and one-request dispatch scoping; durable Secret Service/lease integration and real provider auth are still pending. Parent added exact `.gitignore` exceptions for the three package files and P2 module. Overlay passes 6,627 compared / 287 changed / 0 hidden changed/new / 0 stale rules; diff-check clean. C: 24 GB free; kernel target 12 GB.

### 2026-10-19 resumed continuation checkpoint

Live owners: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P1 has completed its temporary fail-closed Snapshot service closure with a live zero-process regression (1/1); it is using the Bun slot for corrected terminal-runner and origin tests. P2 owns the single Cargo slot for verifier/restart acceptance. P6 is continuing source-only SecretRef→request-scoped auth and Linux Secret Service work; credentialed routes remain unavailable while native runtime retains raw key strings.

P2 supplied the exact private P7 dependency: `HostVerifierArtifactStore` owned by HostKernel, wrapping the generic ArtifactStore with a private authorizer; bounded capture of supervised verifier output must be followed by `verify_ref` for every returned reference before evidence can be accepted. P7 is queued for the next child slot as the whole-phase owner of streaming, artifacts, analytics, automation and checkpoint/rewind. No effectful verifier/finalization, automation/rewind, or worker fan-out is enabled before parent-verified P1/P2 prerequisites.

Intermediate parent checks: overlay visibility `compared=6627 changed=287 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` clean. Tree is mixed staged/unstaged/untracked on main, one worktree; preserve existing ownership. V1 remains PARTIAL; final typecheck, remaining phases, integrated acceptance, push gate and release/install proof remain open.

P2 current Rust evidence update: `cargo test --manifest-path kernel/Cargo.toml --lib host_kernel:: -- --nocapture` passed **37/37** (managed invocation digests, verifier unavailable/fail-closed and retention included); Cargo slot released. This does not enable verifier execution. P1 still owns the required EffectHost wrapper and P7 the production-owned artifact store seam.

P1 current Bun evidence: Core `terminal-run-live.test.ts` passed **15/15, 133 expectations**; OpenCode Snapshot zero-AppProcess regression passed **1/1, 2 expectations**. The old missing-shell race fixture is corrected: missing executable is asserted as preflight no-spawn, while observed `exit 7` covers settlement/replay. Bun is free. P1 now takes Cargo for the managed-verifier EffectHost wrapper/reconciliation and focused Rust tests.

A1 diagnostic checkpoint: integrated `bun run horizoncode:typecheck` exited 2 in `packages/opencode` `tsgo --noEmit`, so TUI/Core checks did not run. P1, P2 and P6 have received their path-owned diagnostics; P6 also owns the typed fatal auth gate in `session/llm.ts` to prevent credential-authorized native unsupported from silently falling back to SDK auth. HorizonCode CLI-host package `github.handler.ts`/`cli/cmd/pr.ts` have unresolved `Interface.run`/unknown Effect diagnostics; `test/project/worktree.test.ts` ownership is P1-vs-P8 triage; `test/tool/repo-tools.test.ts` is P3. Snapshot's new error type also surfaced in the summary caller and heterogeneous test-exit typing. Rerun the complete `horizoncode:typecheck` only after source fixes settle; this failing run is not final evidence.

**Ruling — P1 GitHub CLI effect-origin lease (2026-10-19):** P1 has exclusive ownership of `packages/opencode/src/cli/cmd/github.handler.ts`, `packages/opencode/src/cli/cmd/pr.ts`, and their focused zero-effect tests. The source audit found GitHub API/token, Git/config/remotes, forced PR checkout, nested import and spawned CLI effects. They must fail closed before effects until Guard mediation and no-bypass evidence exist. Cost if wrong: those CLI workflows stay unavailable longer. Parent retains `.gitignore` visibility edits.

A4 follow-up: a concurrent source audit caught three hidden changed P1/P6 paths (Snapshot summary handling and native credential request/test). Parent added only those exact `.gitignore` exceptions; overlay rerun passes `compared=6627 changed=290 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` clean. Rerun after subsequent edits.

P2 repaired the managed verifier consent projection to require and forward complete authenticated HostKernel metadata; focused `test/session/managed-control.test.ts` passed **34/34**. P2 is validating the two distinct durable digests (Guard argument digest vs host canonical bundle content digest) in the current Cargo slot. P6 has the next Bun slot for its native auth/no-fallback work; P1 will take Cargo after P2 releases to build the EffectHost wrapper against that tested API.

P2's revised two-digest HostKernel selector now passes **39/39** (`host_kernel::`, 236 filtered). Guard `argument_digest` and host canonical bundle `content_digest` are distinct fields and must be checked against their matching durable columns. Cargo is released to P1; no verifier launch is enabled until P1 wires/tests the wrapper and recovery.

P2 refined P7's ArtifactStore requirement: `capture_host_verifier_output` alone is not evidence. The private HostKernel owner adapter must bind the authorizer to Goal/Run/Spec/verificationRun/reviewer/Location/owner epoch; reject incomplete capture; verify every returned ref via `verify_ref`; re-read bounded content using the verified permit/scope; and compare refs/metadata/manifest to host output before P2 builds `VerificationEvidenceV1`. The store opens beneath the registered Location state dir and accepts no RPC-supplied refs/bytes/authorizer.

P6 removed raw API keys from native RuntimeStatus/request inputs and added a typed fatal auth gate before native/SDK fallback; unsupported credentialed native paths no longer fall through. Focused native/auth/SecretBroker/secure-input tests pass **29/29, 100 assertions**. The broader provider selector's one stale OAuth fixture was repaired but the full 4-suite wave must be rerun. Preserve both positive request-scoped broker-lease coverage and fail-closed negatives; production SecretRef/store wiring remains incomplete.

**Ruling — durable P2 verifier restart fence (2026-10-19):** same-revision retry requires durable proof the old dispatch never began or target reconciliation proves absence. Persist the approved challenge/invocation and EffectId/one-use lease/execution ID+generation before dispatch, preferably through existing authoritative managed OwnerLog; a bounded private HostKernel journal linked to OwnerLog + EffectIntent is acceptable only if that log cannot atomically store the private data. Restart may reconcile only the exact execution and never redispatch uncertainty. Missing/corrupt/possibly dispatched state is UNKNOWN and blocks retry/finalization; retry after proven absence uses a new EffectId and approval. Keep private lease/executable details out of public event projections. Based on arch_V1 §§14.3 and 11.19; cost if wrong, same-revision verification is delayed until reconciliation.

P2 is coding the restart fence after the 39/39 HostKernel selector. P6's four provider/native/auth suites passed 134/134 (357 assertions) and its focused HorizonCode TypeScript package typecheck (`packages/opencode`) is running. P1 is source-only pending the shared TS slot.

P6 has the four-suite native/provider/auth wave green (**134/134, 357 assertions**). Its focused HorizonCode TypeScript package typecheck (`packages/opencode`) is down to two P6 fixture errors (`provider.test.ts:76` tuple inference; `llm-native.test.ts:679` stale `llmClient` reference); those are being repaired. Earlier P6 SecretBroker/DO/Config diagnostics are resolved. P2's restart journal will be `kernel/src/verifier_journal.rs`, nested privately from `host_kernel.rs`, with no `lib.rs` edit; parent will expose it through exact A4 visibility after creation.

P6 focused HorizonCode TypeScript package typecheck (`packages/opencode`) is now free of P6 diagnostics. Remaining known type paths are P1 Task/Snapshot, P3 RepoTools and P8 worktree fixtures. P1's managed-verifier EffectHost wrapper/recovery and preflight digest mismatch test are source-written; P2 owns two HostKernel compile errors caused by its new verifier journal/member fields and takes Cargo next. P1 takes Bun next for the top-level GitHub/PR zero-effect test and P1 type/test repairs. No verifier dispatch is enabled.

P1's GitHub install/run and PR wrappers now fail typed unavailable with `instance:false` before dynamic imports or effects. Parent reviewed the source; the zero-process, secret-redaction and no-side-effect CLI test awaits the Bun slot. P2 created its private verifier journal; parent added exact visibility exceptions for the new P1 test and P2 source. Latest overlay is clean: 6,627 compared / 293 changed / zero hidden changed/new / zero stale rules; whitespace check clean.

P1's top-level GitHub/PR CLI deny regression passes **1/1, 12 assertions**. It proves all three wrappers return typed unavailable before dynamic imports or fake `git`/`gh`/`opencode` calls, with no secret echo or expected side effects. Those CLI routes are disabled, not Guard-enabled. P1 has Bun next for Task/type fixes.

P2 fixed the HostKernel journal initializer and verifier parser fields; the focused `host_kernel::` selector passed **39/39, 237 filtered**, then Cargo was released to P1. P2 is hardening journal monotonicity, uncertain fsync and non-Unix compile behavior before integrating persistence; rerun after that delta.

Latest HorizonCode TypeScript package typecheck (`packages/opencode`) still exits 2 (39s) with no P6 diagnostics. P1 owns `tool/task.ts`, Task fixture types and Snapshot test union typing; P3 owns RepoTools fixture; P8 owns worktree fixture/API typing. P1's EffectHost Guard-vs-content-digest mismatch test passes **1/1**, preflight/spawn not reached. P2 asks to hold Cargo until journal transition wiring is ready; P1 is using Bun for its type/test repairs.

Parent interim docs/convergence gates pass after tracker updates: Markdown audit **280 files / 0 active blockers / 62 reference-only warnings**; convergence **26 schemas / 205 catalog IDs / 225 registry IDs / 1,226 checks / 0 failures**; `git diff --check` clean. Rerun on final integrated revision.

### Live continuation checkpoint — 2026-10-19

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed control, P6 providers/settings/Doctor/S1 (three child slots). P7 is queued for the next free slot. P2's latest HostKernel/journal selector passed 43/43; it discovered restart currently blocks safely but does not rehydrate/reconcile exact verifier execution as UNKNOWN. P2 continues source-only on that recovery, with finalization disabled. P1 owns the current serialized Cargo slot for the post-dispatch UNKNOWN regression and wrapper recovery. P1 has zero own diagnostics on the latest package typecheck; current other owners are P3 RepoTools and P8 worktree fixtures. P6's initial Linux Secret Service store selector passed 3/3 (16 assertions), but static review returned directory/index symlink/ownership/mode hardening, persistence-failure reconciliation, and real Secret Service CRUD as open requirements. Credentialed routes remain unavailable until those pass.

P1's new subprocess audit assigned Azure CLI OAuth, CLI DB/pager/uninstall, package installation/upgrade, formatter, managed `plutil`, and project Git paths to P1 for Guard mediation or fail-closed zero-effect tests; LSP remains P4-owned. Overlay audit is currently clean at 6,627 compared / 293 changed / 0 hidden changes/new source / 0 stale exceptions. C: free space is 24 GB; `kernel/target` 12 GB. Mixed tree: 150 staged / 178 unstaged / 118 untracked, no conflicts. No staging, commit, push, cleanup, or pruning at this checkpoint. V1 remains PARTIAL; full A1, A2, remaining phases, integrated acceptance and release/install proof remain open.

**Latest integrated typecheck and focused tests (2026-10-19):** Parent `bun run horizoncode:typecheck` exited 2 at HorizonCode CLI-host package `tsgo --noEmit`; downstream TUI/Core gates did not execute. Diagnostics route to P6 Secret Service store decode/callback/test-brand types, P1 Azure origin test fixtures, P8 worktree test API/effect env, and P3 RepoTools fixture. Parent's current P6 store+Secret Service protocol selector passed **16/16, 53 assertions**; live OS keyring and production credential transport remain unverified and Auth stays unavailable. P1's expanded `guarded-legacy-origins.test.ts` timed out at five seconds after adding DB/uninstall invocations; the old 1/1 result does not cover the expanded source, and P1 owns a split/timeout repair. P7 child reports **111/0, 1,174 assertions** on activity/render tests including mounted replay/resnapshot/large history, not yet parent-rerun. P2's journal-based startup recovery source fences restart to exact UNKNOWN without redispatch; its `verifier_` unit selector passed 32/32, but authenticated real-socket UNKNOWN proof is pending. P1 focused Rust reports passed 2/2 managed-verifier selectors and 1/1 challenge UNKNOWN transition. These are phase evidence, not final integrated acceptance. Active implementation owners are P1/P2/P7; P6 is queued on a free slot. Cargo order: P2 socket UNKNOWN selector → P1 Guard/origin/sandbox selector → P7 checkpoint/artifact/automation selectors. Keep effectful verifier, finalization, provider credentials and worker fan-out disabled pending parent-verified prerequisites. Tree remains mixed (150 staged/178 unstaged/118 untracked); no staging, commit, push or cleanup.

### Quota-reset continuation — 2026-10-19 latest observed state

Active phase owners are P1 Guard/ExecutionHost, P6 provider/settings/Doctor/S1, and P7 streaming/artifacts/analytics/automation/rewind. P2's child completed its new authenticated socket restart-UNKNOWN test (1/1, seven filtered), but P2 remains PARTIAL and is queued for a whole-phase resumption. P1 released Cargo after four focused selectors passed: legacy verifier resolution/profile revalidation (1/1), terminal argument mismatch before preflight (1/1), verifier restart UNKNOWN without executable/relaunch (1/1), and profile readiness (1/1). P7 has the next Cargo slot for a source-audited checkpoint capture issue: rejected duplicate/over-limit/invalid-time captures must be refused before immutable blob publication to avoid orphan storage; effectful restore stays disabled. P6 completed its post-fix Bun regressions below.

P7 reran the current TUI suite after the earlier 5-second lifecycle timeouts overlapped P6's TypeScript check: 116 passed / 0 failed / 1,188 assertions / 11 files / 15.83 seconds. Coverage includes mounted activity replay, sequence/generation recovery and 10K histories; bounded redacted rendering and interaction; FULL/SAMPLE/FAILED artifact rendering; SVG worker fallback; analytics provenance. This does not wire P2's private HostKernel ArtifactStore verifier adapter or P1-guarded automation/restore. P7 reports checkpoint journal/capture, ArtifactStore and automation module code exists with prior tests, but needs integrated Rust rerun and cross-owner wiring.

P6 focused post-fix regressions passed from packages/opencode: SecretBroker, Secret Service store/protocol, secure input, offline Doctor/API and provider tests, 137/0 with 369 assertions across seven files. Core feature exposure passed 13/0 with 58 assertions. Live OS keyring and production request-transport integration remain unproven; credentialed auth stays fail-closed/unavailable. Full P6 acceptance remains open.

Parent's latest audits: overlay visibility clean (6,627 compared, 299 changed, zero hidden/stale), convergence 1,226 checks / zero failures, Markdown 280 tracked / zero active blockers / 62 reference-only warnings, and git diff --check clean. One exact test/git/ directory exception was required for the already-listed P1 test. Current Git state is main, 12 ahead/0 behind, 150 staged / 178 unstaged / 125 untracked, zero conflicts, one worktree. C: has 24 GB free (95% used); kernel target 12 GB, indexd target 269 MB, node_modules 2.5 GB. No staging, commit, push, cleanup or prune. Product typecheck and push gate remain open; V1 PARTIAL, native Windows unavailable.

P6 post-fix suite update: OpenCode SecretBroker/Secret Service/secure-input/Doctor/API/provider selector passed 137/0 (369 assertions, seven files); Core feature-exposure selector passed 13/0 (58 assertions); TUI Doctor/question/settings selectors passed 34/0 (129 assertions, seven files); OpenCode S1 selector passed 4/0 (23 assertions). Bun is released to P1 for Guard-owned origin tests and diagnostics. No live OS keyring or production SecretRef transport is proven; credentialed routes remain unavailable.

P1 current owned Bun wave returned 71 pass / 6 fail (180 assertions of 77 selected tests). The owner traced the failures to a missing Effect import in the read-only DB path, install fixtures still expecting now-disabled brew/upgrade probes, and a Git patch test requiring --no-textconv under configured textconv. The CLI zero-effect selector first encountered the DB import failure. P1 is repairing these and owes focused reruns; do not count this wave green. P7 owns the next Cargo run for the pre-publication checkpoint capture defect and its regression tests.

P7's checkpoint pre-publication admission fix passed RED/GREEN on the current revision: `checkpoint::` 8/8, `artifact_store::` 53/53, `automation::` 16/16. The new tests prove duplicate ID, count cap, aggregate byte cap and invalid time refuse before artifact publication. No HostKernel automation or checkpoint restore became runnable; P1 Guard/P8 recovery and P2 verifier adapter dependencies remain.

P6 identified that `SecretPutRequestV1.expectedVersion` could not name the record to rotate. Per arch_V1 §17.6 the parent amended §12.17 and DEC-V1-06: create omits both target and expected version; rotation requires both, preserves SecretRef and atomically increments version; incomplete/stale updates fail without replacement. P6 owns implementation/tests. P1 confirmed no edits to `packages/opencode/src/session/llm.ts`; P6 has an exclusive credential-dispatch/test lease on that file while preserving all managed-session logic. Credential routes remain unavailable until full store→broker→one-request transport integration passes.

P1 fixed and reran its prior 71/6 red origin wave: expanded CLI/install/Git selectors 21/0 (70 assertions); full 8-file HorizonCode CLI-host package origin bundle 74/0 (203 assertions). Core GitV2 zero-effect test is 8/8 (31 assertions) after blocking configured textconv and adding --no-textconv to change capture. The Azure fixture source literal inference issue is fixed. Current package typecheck still has P8 worktree and P3 RepoTools fixture diagnostics; P1 is rerunning for exact output, and the full product command `bun run horizoncode:typecheck` remains required after all owners settle.

Resource/process correction: process inspection found a Cargo build at /home/sarvesh/business_Dev/litecowork (PID 274904), outside this task and user-owned. Preserve it; do not terminate. It temporarily blocks additional heavyweight Cargo/TypeScript work under the shared single-build limit. Continue source-only and rerun after it exits; C: free space remains 24 GB and HorizonCode target sizes have not grown in the latest check.

P1 continuation (historical note; superseded by 2026-10-19 source audit below): Core Git 8/8 (31 assertions), expanded OpenCode origin bundle 74/0 (203 assertions), and Task/ToolBatch 70/0 (353 assertions) were current focused passes. The sandbox is now source-wired to the HostKernel terminal and stdio launch paths, but actual containment and the full Guard acceptance matrix remain unverified; P1 continues whole-phase work.

P7 added a RED source regression for a capture-valid 2,048-path checkpoint manifest whose prospective OwnerLog record exceeds the 1 MiB limit; this must be rejected before artifact publication. The exact prospective event admission implementation and green Cargo rerun remain pending, with no Rust run until the unrelated LiteCowork build exits.

P1 additional origin discovery: `packages/opencode/src/cli/cmd/debug/agent.handler.ts` directly called `tool.execute()` from `debug agent --tool`, bypassing ToolBatch/Rust Guard; the existing test allowed webfetch. P1 owns disabling this path before tool resolution/context/parameter parsing and replacing the positive expectation with zero-network fail-closed acceptance. Rerun its test and overlay audit after the edit.

### Quota-reset continuation — 2026-10-19

- **Live child roster (three slots):** P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, P7 streaming/artifacts/analytics/automation/rewind. P2 remains PARTIAL and queued to resume as a whole-phase owner when a slot opens. P3/P4/P5/P8/P9 and final release acceptance also remain unfinished. P1/P6/P7 have disjoint existing source ownership; parent owns status/integration and will not overlap those files.
- P1's latest expanded CLI/Azure/install/format/project/Git origin bundle passed **79/0, 217 assertions**; Core Git zero-effect suite passed **8/0, 31 assertions**. P1 remains whole-phase incomplete; source-wired sandbox does not yet have integrated containment/no-bypass acceptance.
- P6's broader auth/provider/Doctor/LLM rerun exposed an integration regression: mocked local streams with dummy keys are blocked by the new credential gate, and hosted-workflow denial loses its specific typed-unavailable error. P6 is repairing both without weakening production zero-dispatch policy. No P6 broad-run green claim; keep live credential routes unavailable until the broker transport is proven.
- P7 has the next HorizonCode Rust work, but an unrelated Cargo build in `/home/sarvesh/business_Dev/litecowork` is currently active and not task-owned. P7 is continuing source-only OwnerLog pre-publication admission work until that build exits; do not terminate it or overlap another heavy Cargo build.
- **Resources/integration:** C: `/mnt/c` has 24 GB free (95% used); `kernel/target` 12 GB, `indexd/target` 269 MB, root `node_modules` 2.5 GB. One worktree, mixed staged/unstaged/untracked tree, no conflicts; preserve all state. A1 (`bun run horizoncode:typecheck`) and A2 final push gate remain open on integrated source. No staging, commit, push, cleanup or prune. V1 remains **PARTIAL**.

P1's latest Core acceptance bundle now passes the two formerly failing synthetic runner fixtures: six Core runner/supervisor/terminal/shell files passed **143/0, 636 assertions** in 121.56 seconds. Coverage includes live HostKernel terminal allow/deny, one-use lease, known timeout/nonzero settlement, cancellation receipt, over-limit no-spawn and missing-executable preflight. P1 continues whole-phase Guard/origin/recovery work. P7 has test-first OwnerLog prospective-size regressions in place with rustfmt clean, but Cargo remains held while the unrelated LiteCowork build runs.

P1 source review found the debug-agent zero-effect change removes both direct `tool.execute()` and the obsolete `new Function` params fallback, refusing `--tool` before tool lookup/context parsing. A malicious-parameter marker regression is added but awaits its Bun run; do not count it as verified yet.

### Continuation update — 2026-10-19

The VEO note review now has a proposal at `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md`, linked in the operative plan. It gives candidate HLD/LLD contracts, state flows, event projections, post-V1 phases VEO-F1..F8 and acceptance families. This is design only; V1 P1–P9 are unchanged. P1's debug-agent suite passed 4/4 (12 assertions); the shell-interpolation run timed out before supervisor socket startup, without reaching approval or process dispatch. P1 is running Core typecheck, with `storage.ts` already using GitV2. P6's broad `session/llm.test.ts` passed 36/36 (106 assertions); its corrected RED proves the credential-rotation deletion ordering bug, and journaled recovery work is underway. P7's pure checkpoint eviction preview is present with rustfmt-clean tests but has no Cargo result. C: free is 23 GB; do not overlap the unrelated LiteCowork Windows Cargo qualification. Preserve the mixed Git tree; A1/A2 and all integrated release evidence remain open. V1 is PARTIAL.

Correction/update: P1's Core `bun run typecheck` exited 0 without diagnostics, including the GitV2 storage migration, and Bun is released to P6. C: latest free space is 22 GB. The active LiteCowork Windows Cargo test remains external and must not be interrupted or overlapped by another Cargo build.

P6's standalone Secret Service store tests passed 14/14 (53 assertions); the prior combined store+broker run's unnamed hook timeout is tracked separately. P6's root-turn `next_turn` regression reproduced pending config not being applied; P6 has the exclusive `promptWork` ingress lease and P1 is avoiding that function. P1 found CLI `session delete` and `agent create` origins and added fail-closed early gates, pending zero-effect tests. P1 also source-confirmed HTTP `Project.update` persists DB state/emits events without Guard. It owns a narrow disable at the sole production handler and an HTTP no-DB/no-event regression; P3 may mediate later. Overlay is clean (6,627 compared, 303 changed, no hidden or stale paths); C: 22 GB free. V1 remains PARTIAL.

P6's test-first root-turn settings fix passed its focused selector: 2/2, 5 assertions, with `applyPendingFeatures` limited to new root prompt ingress and child Attempts staying pinned. P1 has the released Bun lane for its CLI and HTTP project-origin no-effect tests; no Cargo overlaps the external LiteCowork Windows qualification.

P1's latest CLI legacy-origin bundle passed 1/1 (29 assertions); the Project.update HTTP suite passed 3/3 (15 assertions), including typed 503 before mutation with unchanged DB and no event. P1 owns newly discovered legacy MCP-config, auth/logout OAuth credential, and plugin/package-install paths for fail-closed mediate-or-disable and zero-side-effect proof. P6 takes the current Bun slot for its post-activation credential-store recovery regression. P7 is adding prospective OwnerLog admission while Cargo remains held by external LiteCowork builds.

P6's post-activation key-retirement recovery regression passed 1/1 (8 assertions). A combined Secret Service store+broker run has one unnamed teardown-hook timeout despite all named tests passing, so only focused store/recovery selectors count green. P1 has expanded the legacy CLI closure to account login/logout/switch/open/orgs and provider auth/config/plugin installation, disabled pending focused no-network/no-write evidence and P6's replacement auth path.

P6's credential-denial path now checks config/auth/model before provider construction. The RED-first plugin-hook counter passed after repair (1/1, 3 assertions): zero plugin callback and zero HTTP on a credential-denied route. Full LLM and standalone broker/prompt checks remain due; this does not establish production SecretBroker transport.

Current P6 reruns are green: full LLM 36/36 (107 assertions), standalone Secret Service store 15/15 (61), standalone SecretBroker 10/10 (42), root-turn settings 2/2 (5), and post-activation credential retirement recovery 1/1 (8). P7's two checkpoint prepublication selectors passed 1/1 each; full checkpoint module 14/14 plus rustfmt. P7 returned PARTIAL with effectful restore/eviction gated on P1/P2/P8. Its child slot is now assigned to P2 whole-phase managed vertical; P1/P2/P6 are current active owners. External LiteCowork Cargo restarted, so hold HorizonCode Rust builds; C: is at 20 GB free. P1 CLI MCP/auth/account/plugin gates remain under test/debug, with managed-control files reserved to P2.

### 2026-10-19 contract and phase correction

The delegation design is now explicit in §12.18: P2 owns the canonical private IPC `contracts-v2/delegation-binding-v1.schema.json`, shared golden fixture and Rust decoder tests. u64 owner epoch/managed revision values are canonical decimal strings in the MessagePack body; digest is domain-separated BLAKE3 over the fully validated canonical map. Managed admission fails before effect preparation if accepted Attempt/profile/context/workspace/capability/budget/resource state or live leases are absent/stale. P1 reviews and enforces the HostKernel/Guard path; P2 verifier/finalization remain disabled until P1 and P7 artifact acceptance. §4.13's named UI lifecycle labels are projections over existing owner records/cursors and do not add durable OwnerLog kinds or a second event bus.

P6 owns newly discovered usage provenance across session usage fields, producer and projector: missing cache counts or model prices must remain unknown rather than numeric zero. It has exclusive path-level scope on those usage producer/schema/projector files; P7 owns UI renderer and analytics consumption. P6 Provider Doctor tests passed 7/7 (22 assertions), ModelsDev refresh passed 2/2 (5 assertions); catalog network remains unavailable. P1 provider-list denial passed 1/1 (4 assertions); shell interpolation test is active. P2 focused TUI review/proposal/verification passed 3/3. Three child slots are active (P1/P2/P6); P3/P7/P8 remain queued. C: has 20 GB free; external LiteCowork Cargo is active; do not start a HorizonCode Cargo build.

### Current phase and design checkpoint — 2026-10-19

**Accepted phase design:** A-V2-33 records the critical review of the complete supplied note. P1/P2/P3/P6/P7/P8 have explicit required V1 refinements; P4/P5/P9 retain scope. Logical contracts, HLD flows, event projections, LLD and acceptance IDs are in arch_V1 §§3.21/4.13/10.17/12.18/29.20/30.23/31.19/32.38/37.22. These remain design requirements until source, machine schemas, cross-language fixtures and runtime acceptance pass. VEO-F1..F8 are post-V1 proposals only.

**Current evidence:** P1's corrected effectful CLI-origin selector passed 1/1 (31 assertions), covering 14 subprocess routes; the earlier run executed a fake `bun` shim. `providers list` and eager ModelsDev refresh were then identified as network/cache origins. P1 owns early-disabling the CLI route; P6 owns ModelsDev/AppRuntime refresh behavior. P1's workspace digest race regression is not run because external LiteCowork Cargo is active. P2's `goal.verify` path and test are present; `packages/tui` typecheck and the focused app suite passed 3/3 (review, proposal and verification). P2 managed verification remains fail-closed until P1 confinement and P7 ArtifactStore evidence pass. P6's ModelsDev source avoids implicit startup refresh; no-startup-request test passed, but explicit refresh failed because the test bootstrap sets the fetch-disable flag; P6's isolated mock override rerun is pending. P6 prompt/config checks passed 2/2 and 2/2.

**Resources and integration:** C: has 20 GB free; `kernel/target` is 12 GB. Do not run HorizonCode Cargo while LiteCowork qualification is active. Git remains `main`, 12 commits ahead of `origin/main`, with mixed staged/unstaged/untracked paths and no conflicts; no exact task-owned publication boundary is safe. Markdown audit after phase docs: 0 active blockers / 62 archival reference-only warnings; convergence: 26 schemas, 205 catalog IDs, 225 registry IDs, 1,226 checks / 0 failures. V1 remains PARTIAL; final typecheck/push gate, P1/P2/P3/P4/P5/P6/P7/P8/P9 end-to-end evidence and release gates remain open.

Correction: P1 proved `providers list` denial before AppRuntime effects RED→GREEN: the regression first failed because the command exited 0 after startup; moving it to a raw pre-runtime command made the focused case pass 1/1 (4 assertions), with zero loopback HTTP and zero cache writes while fetch was enabled. P1 does not claim global network closure; P6's ModelsDev startup/read lifecycle is separate. P2 source audit found managed Attempts do not yet persist immutable profile/capability/context digests; P2 sent the gap to P1 and did not edit shared Guard/protocol files. P6 diagnosed its explicit-refresh test issue as the test bootstrap's fetch-disable flag; its injected-mock fixture correction/rerun is pending. Cargo remains blocked by external LiteCowork.

Correction: P1's shell-interpolation selector completed 0/1 after Guard approval, successful process exit and marker creation; 13 assertions passed, then the final fake-LLM input assertion saw no inputs. P1 is diagnosing the slash-command turn fixture/flow. This run did not fail at Guard denial or confinement; Bun lane is released.

Latest correction: P2's focused binding protocol test command ran no tests because compilation stopped on two current P1 `host_kernel.rs` errors (PathBuf versus `&Path` near line 9016 and tuple versus borrowed tuple near line 9070). P2 released the Rust lane; P1 owns repair. Binding schema/decoder exists in the shared tree, but the golden digest and complete malformed-vector coverage remain open. P6 usage provenance selector was 2 pass/1 fail because of a legacy fixture encoding mismatch; P6 owns the fix and released Bun. Architecture checks after additions: Markdown active blockers 0 (62 archive-only warnings), convergence 27 schemas / 1,227 checks / 0 failures, relevant diff check clean.

Correction: P1 fixed both compile errors and ran `cargo test --manifest-path kernel/Cargo.toml --lib host_kernel::tests::workspace_revision_rejects -- --nocapture --test-threads=1` → 2 passed / 0 failed, covering symlink swap and atomic same-path replacement. Rust lane is released to P2 for one binding selector. `rustfmt --check` still reports pre-existing/shared P2 hunks; P1 did not reformat shared files wholesale.

P2's binding selector next reached crate build but stopped on a new P1-owned compile error: `host_kernel.rs` `settled_attempt()` initializer near line 13273 is missing `delegation_binding`. P2 released Cargo; P1 owns the fix. No binding golden test ran yet.

Correction: P1 added `delegation_binding: None` to the settled-attempt test helper; Rust lane is back with P2 for its binding selector. P1 holds Bun until Cargo completes; P6 continues source-only.

P2 replaced the golden fixture placeholder with canonical digest `blake3:1fd75f1bc0f3999bfc38131ce367cd71ff22e9d0e442de1264ebced0b2c1e81b`. Focused result: `cargo test --manifest-path kernel/Cargo.toml --lib protocol::tests::delegation_binding -- --nocapture` → 2 passed / 0 failed (golden + hostile decoder). Rust lane released to P1. This is protocol proof, not persisted Attempt/admission proof.

Latest P1 interpolation result after fixing the test's missing model selection: the empty-LLM assertion now passes, but command Fiber exits unsuccessfully after `allow_once` and the marker remains absent. Selector 0/1, 11 assertions, 11.26s; P1 is tracing the actual terminal outcome/error. Treat as an unresolved guarded product-path regression. P6 has Bun for usage selectors, which passed 3/3 (25 assertions); it is running the Core runner usage regression. P2 added binding digest/canonical-string validation to managed-control TS plus zero-RPC negative test; validation waits for the Bun lane.

Overlay audit initially found 8 hidden changes and 4 hidden first-party files. Added exact ignore exceptions plus required test/lib parent; rerun is clean: `OVERLAY_VISIBILITY compared=6627 changed=311 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`.

Correction: P1's remaining interpolation failure came from its fixture passing a model-ref object where slash-command `CommandInput.model` requires a string; the reported error was `model.split is not a function`. The fixture now uses `model: "test/test-model"`; one final rerun waits for P6's Bun lane. This is not a product Guard defect.

P2 reports persisted Attempt binding/replay in managed OwnerLog, admission-revision/spec/task/owner/workspace validation, and fail-closed effect-intent admission when binding is absent. A focused Rust test for no-effect-before-binding, stale revision, reopen and exact replay is added but not yet run; P2 has the Rust lane. TS scope digest/counter validation and zero-RPC malformed input test are added but pending.

P6 usage schema now binds Provider.ID/Model.ID; measured cost requires recognized `provider-billing-receipt-v1` and an evidence ref (no V1 producer emits it); estimates require SHA-256 pricing revision, exact price components, algorithm and token input snapshot. Unknown metrics cannot carry values. Schema regression rerun 3/3 (27 assertions); producer/projector regression remains in progress.

P6 focused producer/projector tests are green: OpenCode usage selectors 3/3 (14 assertions); Core projection selector 1/1 (3 assertions), including unknown cache/cost and absence of misleading legacy scalar values. Bun released to P1 interpolation, then P2 managed-control TS selector.


### 2026-10-19 continuation checkpoint

- P2's persisted delegation-binding integration selector is green: `cargo test --manifest-path kernel/Cargo.toml --test managed_control immutable_delegation_binding_is_atomic_replayable_and_required_for_effect_intents -- --nocapture` → 1 passed. It proves denial before binding, stale admission revision rejection, replay/idempotence, authorized intent while live, exact binding retention on reopen, and `UNKNOWN` fencing that denies redispatch. P2 still owns the whole managed phase; production binding inputs, actual-workspace verifier evidence, Core→TUI review delivery, and final real-socket recovery remain open.
- P1's corrected shell interpolation journey reached successful Guard approval and terminal dispatch; receipt/process succeeded and the marker exists, but the interpolated text did not reach the follow-up model input. This is a real continuation-path defect P1 owns, not a fixture issue. The Bun lane is released. Continue P1's full origin, lease, receipt, cancellation/restart and confinement matrix; effectful dependent routes remain gated.
- P6 retains top-level V2 `usageProvenance`; no shared P7 projection reshuffle. Its latest schema/provider gaps remain under source work; its focused schema/OpenCode/Core rerun is queued behind P2's managed TS selector. Offline Doctor remains truthful UNKNOWN without a supplied offline source; provider catalog/network probes remain Guard-gated.
- Current child roster remains P1, P2, P6 (all whole-phase owners); P3/P7/P8 and other unfinished V1 phases/release work are queued until slots free. C: `/mnt/c` has 22 GB free; `kernel/target` is about 12 GB and `indexd/target` 269 MB. One worktree; no conflicting processes reported. Preserve the mixed staged/unstaged/untracked tree; no staging/publication or cleanup. V1 remains PARTIAL.


Correction to the 2026-10-19 continuation checkpoint: P6 reran the focused V2 usage provenance checks after schema tightening and cache-write fallback changes. Results: schema + event stream 3/3 (27 assertions), OpenCode producer 3/3 (14 assertions), Core projector 1/1 (3 assertions). V2 remains top-level `usageProvenance`, preserving `unknown` rather than coercing missing cache/cost data. These selectors do not close P6's provider/settings/Doctor/S1 phase. Bun is now assigned to P1's test-first interpolation continuation repair; Cargo is assigned to P2's managed-control integration binary.


P2's full `managed_control` integration binary is currently blocked before test execution by a P1-owned borrow-check error in `kernel/src/host_kernel.rs` (E0502 around lines 8713–8734: immutable `host.locations` borrow overlaps mutable managed snapshot access). P2 released Cargo; P1 owns the repair and must notify P2 when the Rust lane is ready for the full binary retry. This does not invalidate the separately green 1-test persisted-binding selector.


Correction: P1 repaired the managed-control compile blocker by cloning the validated canonical workspace root before borrowing managed control mutably, then released Cargo to P2 for the full integration binary retry. This source fix is not yet independently verified; the retry is pending. P1's interpolation journey remains unresolved after successful terminal execution because the generated model input omits the command output.


P2 full managed-control integration retry after the P1 compile fix built successfully and ran 38 tests: 33 passed, 5 failed. Four P2-owned scheduler/fan-out fixtures need valid criterion IDs in their test binding helper; one final-revision test now correctly rejects a stale verifier path because typed independent evidence is missing. P2 owns fixture/evidence repair without weakening the new contract and will rerun the complete binary. The managed-control TypeScript malformed-scope selector also passed 2/2 (34 filtered), including typed error before RPC. Cargo and Bun are released; P6 is taking Bun for its independent next selectors/source work.


Correction: P1 traced the interpolation selector's empty model-input assertion to the positive test inheriting `apiKey: "test-key"` from shared `providerCfg()`. P6's credential gate correctly denies provider dispatch when the fixture carries that credential; terminal execution and receipt had succeeded. P1 is removing the key only from the local-server positive fixture and retaining separate credential-denial coverage. Treat the prior “continuation-path defect” wording as superseded; this was fixture setup, not production interpolation behavior.


Correction: P1's shell interpolation acceptance selector is green after a fixture-only change to use an uncredentialed local `test` provider while keeping the mock server URL. `cd packages/opencode && bun test --timeout 180000 test/session/prompt.test.ts --test-name-pattern 'single slash-command shell interpolation executes after Rust approval and returns its outcome'` → 1 pass / 0 fail, 13 assertions, 10.45s. It verifies Guard `allow_once`, process/receipt marker, and `INTERPOLATION_APPROVED` in the next model input while preserving separate credential-denial coverage. This selector does not close P1's remaining origin/confinement/batch/recovery matrix. Bun is released to P6's Guard-gated provider-transport adapter work.


P1's focused HostKernel selector compiled but did not reach its intended stale-binding assertions: the fixture returned `feature_not_negotiated` before it could assert `managed_not_found` (0/1 selector). P1 will update the test fixture to negotiate the managed feature through the real path; production feature gating remains unchanged. Cargo has returned to P2 for the full managed-control retry; avoid concurrent edits/builds against `host_kernel.rs`.

Current read-only audits after tracker updates: `audit_markdown_repo.py` reports 280 tracked Markdown files, 0 active blockers and 62 archive-only warnings; `validate_convergence.py` reports 27 schemas, 205 catalog IDs, 225 registry IDs, 1,227 checks and 0 failures; overlay visibility reports 6,627 compared, 311 changed, 0 hidden changes/new source/stale unignore. C: remains 22 GB free; Rust target trees 12 GB and 269 MB.


P2 repaired the four invalid managed test bindings; the next full managed-control binary reached 37/38 passing. The final failure is an obsolete scheduler regression assuming digest-only `RecordCriterionEvidence` can finalize a Run. P2 is replacing it with a negative finalization assertion plus typed independent evidence acceptance for revision B and stale revision A rejection. Cargo is free during this edit. P1's focused HostKernel test also needs `set_effects_enabled(true)` in the fixture to reach the managed stale-binding check; P1 is editing that separate test fixture and will hand Cargo back to P2 for the next integrated binary.


P1 HostKernel selector after adding the effects-v2 fixture negotiation passed that earlier gate and reached the intended denial path; it then exposed a P1 test assertion that incorrectly expected the ephemeral approval challenge to remain after denial. Production correctly removes denied challenges. P1 will update the assertion to require challenge removal and no lease; no Rust build until P2's managed-control retry finishes.

P6's private provider transport adapter has now been strengthened before production wiring: its digest binds provider, POST method, exact HTTPS destination, auth-header mapping, canonical sorted ordinary headers and body; mismatch is denied before broker consumption/send. It carries cancellation/deadline to one send and bounds streamed responses to at most 10 MiB. The focused SecretBroker transport suite passed 13/13 (57 assertions); P6 then replaced locale-sensitive header sorting with deterministic code-point order, so one short rerun remains. The production provider dispatcher remains unwired/fail-closed pending P1 Guard acceptance.


P2's corrected full Rust managed-control integration binary is green on integrated P1 source: `cargo test --manifest-path kernel/Cargo.toml --test managed_control -- --nocapture` → 38 passed, 0 failed, 0 ignored (12.63s). Coverage includes persisted binding admission/replay/restart-UNKNOWN, no digest-only finalization, and cancellation of incomplete verification. P2 still owes a focused Rust library unit run for stale revision-A rejection/current typed revision-B acceptance, real-socket lifecycle/review integration, and the full actual-workspace verifier/artifact vertical; Cargo is with P1 for the corrected HostKernel selector. P6 owns the Bun lane for provenance/header-order/Doctor/S1 selectors.


P2's added typed-evidence unit test is green: `cargo test --manifest-path kernel/Cargo.toml --lib managed_control::managed_verification_evidence_tests::new_final_revision_rejects_stale_evidence_then_accepts_typed_current_evidence -- --nocapture` → 1/1, 299 filtered. It rejects revision-A evidence after moving to B, accepts typed independent evidence bound to B, and permits the manager transition. P1's focused test correction (assert denied challenge is removed and no lease exists) is pending a rerun; the prior failure reached the intended managed denial path.

P6 hardened provider transport with deterministic canonical headers, lease-bound digest, abort/deadline and bounded streamed response tests. Latest `secret-broker.test.ts` passed 14/14 (61 assertions), proving deadline abort, one lease/send and auth-header cleanup. P6 now owns the serialized HorizonCode CLI-host package/LLM typecheck slot; production provider dispatch remains disabled until P1 network Guard acceptance.


P1's corrected focused HostKernel managed denial selector is now green: `cargo test --manifest-path kernel/Cargo.toml --lib host_kernel::tests::stale_or_changed_managed_attempt_scope_is_denied_before_approval_lease -- --exact --nocapture --test-threads=1` → 1/1 passed (299 filtered); it verifies deny-before-EffectHost DB creation and challenge removal. P1's source audit then found a recovery revalidation gap: recovered scope verifies immutable binding lineage/current workspace/effect intent but not the envelope's expected OwnerLog revision or current active Run/Task/Attempt phase/identity. P1 owns tightening recovery and deny/no-relaunch tests. Do not claim P1 complete.


P6's integrated HorizonCode TypeScript package typecheck (`packages/opencode`) currently fails after the new transport work. P2 reports no diagnostics in P2-owned `src/session/managed-control.ts`; diagnostics are in P6-owned `src/session/llm.ts`, `src/session/session.ts`, `test/auth/secret-broker.test.ts`, and `test/session/llm.test.ts`, plus two existing test files (`test/project/worktree.test.ts`, `test/tool/repo-tools.test.ts`) that require confirmation whether newly introduced. P6 owns exact output triage and repairs, then must rerun the package check and `packages/llm` typecheck. No P6 typecheck acceptance is claimed yet.


Correction: P6 captured the exact typecheck diagnostics after the failed HorizonCode CLI-host package check: `session/llm.ts` uses invalid `configured.key`/`configured.headers`; `session/session.ts` has possibly-undefined token and price inputs for estimated cost; `test/auth/secret-broker.test.ts` fixtures omit the newly required `signal`/`maxResponseBytes` and widen credential-header names; `test/session/llm.test.ts` has duplicate `env`. P6 owns those repairs, then will rerun HorizonCode CLI-host package and `packages/llm` typechecks serially. Remaining diagnostics in `test/project/worktree.test.ts` and `test/tool/repo-tools.test.ts` belong outside P6 and must be triaged to their phase owners after current fixes.


P6 typecheck progress: after fixing its four production/test paths, `packages/llm bun run typecheck` passed with no diagnostics. HorizonCode CLI-host package now has no reported P6 errors; only queued P8 `test/project/worktree.test.ts` errors (Interface `.run` missing at lines 68/75 and Effect environment `unknown` at 124/154/246/269) and P3 `test/tool/repo-tools.test.ts:220` overload mismatch remain. These are exact phase-owner tasks, not P6. P6's strengthened provider transport suite passed 15/15 (62 assertions), including canonical header order, changed-field denial before lease consume, one-use replay denial, cancellation/deadline, and bounded response. Production dispatcher remains unwired.

P1 owns a narrow compile repair in `kernel/tests/managed_settlement_provenance.rs` (fixture helper must return `RpcResponseV1`; `expectedManagedRevision` is a decimal-string wire value); P2 confirmed no concurrent edits to that file. P1 will run its selector and return Cargo to P2.


P1's `managed_settlement_provenance` compile/behavior selector is now green: 5/5. The corrected denial assertion checks zero durable effect challenges, zero workspace mutation, Attempt remains EXECUTING with no effect edge/receipt; it no longer falsely assumes `register_location` leaves no database file. Cargo is released to P2 for the atomic binding seam RED/GREEN. P1 is source-only on recovery predicate/test design until that Cargo wave ends.

P6's latest usage regression caught that the cost estimate consumes adjusted token counts, while `tokenInputs` recorded raw counts. P6 corrected provenance to record adjusted non-cache input and non-reasoning output; focused HorizonCode CLI-host package usage tests pass 2/2 and the SecretBroker/transport suite 15/15 (62 assertions). HorizonCode TypeScript package typecheck (`packages/opencode`) rerun is queued for this exact source revision.


P6 reran HorizonCode TypeScript package typecheck (`packages/opencode`) after its final usage-cost adjustment: it exits 2 with the same four P8 `test/project/worktree.test.ts` diagnostics and one P3 `test/tool/repo-tools.test.ts` diagnostic; no P6-owned diagnostics remain. `packages/llm bun run typecheck` passed earlier with exit 0; the last cost adjustment was HorizonCode CLI-host package-only. Final integrated product typecheck remains blocked until the queued P3/P8 owners repair their paths.


P2's new managed delegation admission seam test is green: `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib managed_control::managed_delegation_admission_tests::delegation_admission_derives_accepted_scope_and_rejects_stale_owner_facts -- --nocapture` → 1/1 passed, 300 filtered (compile 1m04s). It derives accepted scope from durable managed state and rejects stale owner facts. P2 is now implementing one composite OwnerLog admission event so `Attempt`, workspace revision and immutable `DelegationBindingV1` share the exact post-append managed revision; no separate partially-bound interval. The integration selector remains pending. Cargo lane is free for P1 recovery work.


P1 recovery implementation is now source-present but awaits cross-phase compile: it binds recovery validation to the expected managed revision's persisted effect-edge lineage, requires the exact managed effect edge, requires restarted in-flight Attempt UNKNOWN with matching active Task/unknown-effect and Run RECONCILING/CANCELLING, validates terminal target + OwnerLog receipts and matching exit outcome, and keeps `status_execution` read-only/no-relaunch. Direct recovery also validates workspace/effect-edge revision floor and phase/receipt rules. Its focused compile currently stops because P2 is implementing the referenced `admit_attempt_with_delegation` method; P1 is working independent origins source-only until P2 reaches a compilable checkpoint.

P6's integrated selector wave is green: HorizonCode CLI-host package 193/0 (493 assertions, 9 files); TUI 30/0 (120, 4); Core FeatureExposure 13/0 (58); Schema Doctor/SecretBroker/usage/event 13/0 (70). It includes full LLM/config and next-turn behavior, offline Doctor/no-network, S1 route/tool, local provider/model switch/price, and Secret Service rotation. `packages/llm` typecheck passes; HorizonCode TypeScript package typecheck (`packages/opencode`) is clear for P6 but remains blocked only by queued P3/P8 test diagnostics. P6 remains PARTIAL: production SecretBroker auth/transport is still unwired, OS login keyring integration/accepted live free-model journey are absent, and guarded network/catalog probes remain unavailable pending P1.


P6's production credential boundary ruling: raw `Auth.Info`/`Auth.set` are not safe for V1 SecretBroker because they expose raw key/access/refresh values; §14.7/§12.17 requires puts to receive only an opaque `secureInputHandle`. P6 is implementing a lazy metadata/store surface (`put` accepts only SecretBroker PutRequest + opaque handle; `describe/revoke` return metadata), backed by SecretBroker + Linux Secret Service store. Legacy raw `Auth.get/all` remain empty, raw `set/remove` unavailable, ProviderAuth denied until guarded secure-entry exists; no D-Bus startup probe. Injected lifecycle/restart/denial tests can pass here, but actual OS integration is NOT VERIFIED because no Secret Service is installed in the session.


P1's six-file CLI/origin bundle ran 7 passed / 1 failed with 77 assertions; its sole failure was a stale expected unavailable-message string in `provider-url-auth-disabled.test.ts`. P1 updated only the expectation to the current typed unavailable message and reran that file 1/1 (7 assertions). Combined final evidence for the touched set is 8/0 (the other seven tests passed in the bundle), covering providers list zero HTTP/cache, MCP/auth/console/plugin zero effects, legacy process/mutation denials, MCP add config denial, installer upgrade zero effects, Snapshot zero process and URL-provider login zero fetch/spawn/auth mutation. Wider P1 ToolBatch, authenticated Task/subagent, receipt/UNKNOWN/cancel/restart, actual confinement and final integrated matrix remain open.


P1 recovery predicate suite is green: `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib recovery_ -- --nocapture --test-threads=1` → 3/3 passed, 301 filtered. Coverage includes persisted-owner UNKNOWN, UNKNOWN + Run RECONCILING/CANCELLING + matching active Task fence, denial for live/executing or mismatched owner phases, managed terminal target/OwnerLog receipt and exit-outcome mismatch, and direct receipt/outcome mismatch. This is predicate-level evidence only; production recovery still needs trusted binding/live-lease construction and real process/no-relaunch journey.

Parent integration review found P2's generic `ManagedDelegationAdmissionFactsV1::from_owner_proofs(raw strings/u64)` constructor too forgeable to serve as an owner proof seam even though crate-private. P2 is replacing it with composed opaque typed proofs created by P1 HostKernel execution/workspace, P8 durable lease, and P2 registered profile/context owner services. No IPC layer may construct these. Until every proof constructor resolves live canonical state, managed effect binding remains unavailable.


Integrated rerun after P2's atomic admission implementation: P1 `recovery_` module still passes 3/3 (301 filtered) against current shared source. P1 released Cargo to P2 and continues source-only on managed effect cardinality and remaining Guard/ExecutionHost boundaries. This validates the predicate suite compiles with the P2 API; it does not create the missing live P1/P8/profile/context owner proofs or real recovery journey.

## 2026-10-19 continuation checkpoint

See `CURRENT_RUN.md` for the current source-backed evidence. P1/P2/P6 are the only active whole-phase owners. The platform rejected a fourth child with `agent thread limit reached`; launch P8 next for typed durable reservation proofs and full P8 acceptance when a slot frees, then P3 or other runnable whole phases according to the dependency graph. P1's HostKernel managed admission must remain deny-before-OwnerLog-mutation until typed live owner proofs are consumable. P2's atomic admission selector is 2/2 and exact effect-edge lineage API is in progress; this is not a managed vertical acceptance. P6 credential/auth selector is 47/0 (192 assertions), but real Secret Service is unavailable and provider/credential effects remain gated. Overlay visibility and convergence audits are clean on the current tree. C: free space is 21 GB; retain caches and preserve the mixed tree. V1 remains PARTIAL; no final gate, commit, push or cleanup has occurred.

Latest follow-up evidence: P1's `managed_admission_without_typed_owner_proofs_has_zero_owner_or_effect_mutation` RPC regression passes 1/1 and confirms deny-before-Goal/OwnerLog/effect/workspace mutation. P1 consumes P2's persisted exact effect-edge revision and requires `expectedManagedRevision + 1`. P2's edge-lineage reopen/pause selector passes 1/1, preserving revision R while fencing the reopened Attempt UNKNOWN (exact command requested). P6 offline Doctor malformed/mismatched-ref selector is 8/8 (28 assertions), still zero-dispatch; live route/TUI selector is next. All are partial phase evidence; V1 remains PARTIAL.

P6 Doctor follow-up is green: OpenCode API tests 12/0 (54 assertions) and TUI Doctor journey 4/0 (14 assertions); offline reads are Config/ModelsDev only with no Provider/Auth/plugin/secret/network dispatch. P6 is fixing SecureInputVault expiry capacity and shutdown zeroization next. All phase owners were directed to reuse/adapt exact pinned OpenCode/OMP/Codex source per `repo_take/NOTES.md` and §42; Guard and managed ownership stay Horizon canonical.

Contract source closure: existing `SpecVersion.scope` is path scope and cannot authorize effects. Normative docs now require explicit canonical `capabilityScope` on immutable SpecVersion and Task `requiredCapabilities` subset, empty-as-deny, and a ceiling intersection with profile/current Guard. Core Config owns profile revisions; Core ContextService owns bounded context compilation; Rust retains per-Attempt snapshots only. P2 is implementing real typed schema/wire/source. Post-edit Markdown audit has 0 active blockers, convergence has 0 failures, and overlay visibility has zero hidden changes/new source/stale unignore.

P1 has wired HostKernel projections for accepted Spec capability scope and persisted Task-required capabilities. First integrated RPC binary: 11/12; sole failure is a stale error-code assertion (`invalid_effect_request` vs early `capability_unavailable`), owned by P1. P2 owns the current Cargo lane for the new Rust accepted-scope and subset invariants; then P1 reruns the exact ingress/zero-mutation tests.

Additional P2 contract ruling: `AgentProfileV2` now requires an explicit bounded canonical `capabilityCeiling` list; digest-only permission summary is insufficient to derive effective capability IDs. Empty is no managed effects; no inference from tool/path/MCP patterns. P2 implements the single Core profile owner; P1 intersects with current Guard policy; registry JSON remains ID/alias design seed only.

2026-10-19 continuation: the live whole-phase roster is P1 Guard/ExecutionHost, P2 managed vertical and P8 resource/workers/RC0. P6 finished its current assignment as PARTIAL and its child slot was reused for P8. P8 RC0 Python tests passed 48/48; P8's single Cargo suite is currently running. P1 reports focused Linux confinement 5/5, settlement provenance 5/5 and workspace race 2/2; no complete enabled-origin matrix or live typed proof path yet. C: 21 GB free; preserve the 12 GB `kernel/target` cache. Other requested phases remain P3/P4/P5/P6/P7/P9 and final integration/release gates; none VERIFIED/RELEASED.

Managed profile transport is now fixed in §17.13: existing authenticated Core→HostKernel private IPC, OS peer/handshake/fence for process identity and out-of-body validated ServerAuth for delegated user identity; no extra service principal/registration endpoint/global Rust profile registry. P2's complete `AgentProfileDefinitionV2` input has no trusted digest fields; HostKernel validates it, computes domain-separated canonical MessagePack BLAKE3 digests, and persists only per-Attempt immutable refs atomically with admission. The existing machine schema is updated in place to match §29.2. The effective P1 capability digest is separate and includes the live Guard policy intersection. Effects remain unavailable until P1/P2/P8 live owner proofs, leases and adversarial acceptance pass.

Latest phase test delta: P8 Rust worker/resource/worktree/reservation suite passed 226/226 and RC0 Python selector passed 48/48; its WSL2 selfcheck measured only its own process + sleep child and does not count as product baseline evidence. P8 is adding durable bounds/replay compatibility and needs separate actual-product RC0 baselines. P1 Task/subagent suite passed 15/15 (117 assertions), shell interpolation allow/deny passed 2/2 (18 assertions, deny zero-spawn), and focused Linux confinement 5/5, workspace-race 2/2, settlement provenance 5/5, ToolBatch 17/17, Direct Attempt RPC 10/10. Overlay audit after exact source exceptions: hidden source/stale ignore counts zero. Markdown audit exit 0 (280 tracked, 0 active blockers, 62 archive-only warnings); convergence exit 0 (28 schemas, 1,228 checks, no failures). C: remains 21 GB free. P1/P2/P8 and V1 remain PARTIAL; no push gate, commit or publication.

Further current-source results: P8's durable bounds/replay follow-up passed 139/139 Rust tests; rustfmt passed. P2's canonical profile-definition and permission-ceiling hash tests passed 2/2 with shared TS/Rust golden digests. P1's broad nine-file OpenCode origin bundle passed 60/60 (217 assertions). P1 is adding deep HostKernel profile validation and authenticated zero-mutation evidence; a digest helper or TS/schema test alone is not managed authority. P8 owns repair of the remaining `test/project/worktree.test.ts` TypeScript diagnostics and current product resource baselines; its Bun/tsgo lane is active.

P8's focused `test/project/worktree.test.ts` passed 14/14 (34 expectations), and the subsequent package typecheck reported no P8-owned diagnostics. Remaining diagnostics are P2/Core managed settings/capability fields and P3 `repo-tools` typing. P8 still owes product-level RC0 baseline and whole-phase acceptance.

P8 then returned PARTIAL with no active Cargo/Bun/tsgo process: durable worker bounds/replay and its P8 selectors passed, the worktree suite passed 14/14, and P8 typecheck diagnostics are cleared. Its release-critical RC0 baseline is still blocked until a real Core/Rust-owned live Session/Run attestation source exists. P3 RepoIntel is now active in the freed child slot, alongside P1 and P2. P1's strict HostKernel profile decoder passed 1/1; its malformed-auth RPC test awaits P2's private `profileDefinition` schema/wire field and remains fail-closed.
# 2026-10-19 continuation handoff (latest)

User requested faster completion by adapting existing pinned OpenCode/Codex/OMP implementations. Use existing code and product seams wherever compatible; do not create duplicate runtimes or bypass Guard/managed ownership. Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P3 RepoIntel (the platform permits three child slots). P8 previously returned PARTIAL and is not active. P4–P9 remain in the V1 scope and queued for freed slots. Parent owns integration and final acceptance.

Cross-phase contract review required admission to bind `ContextSelectionV1.sessionID` to the authenticated managed admission `sessionID`; P1 has now implemented and tested this denial boundary. P2 still owns a stable digest golden vector and Core/schema/Rust decoder parity. P3 is reusing existing indexd/OpenCode RepoIntel components; keep its production query unavailable until P1 authenticated read-scope grants and bounded transport are verified.

P1 has since completed the profile/context focused bundle: Rust context decoder/session binding 2/2, strict profile decoder 1/1, managed RPC integration 15/15. The foreign-session negative verifies zero mutation. P2 is using the next shared Cargo lane; P3's schema/fixture bundle is 7/7 (47 assertions) and its HorizonCode TypeScript package typecheck (`packages/opencode`) is being rerun. These are phase-internal checkpoints; P1/P2/P3 remain PARTIAL, and no managed effect or RepoIntel production read is enabled.

Latest: P2's `managed_control` integration suite passed 39/39; P3's RepoIntel/RepoTools suites passed 54/54 (380 assertions), schema/fixture 7/7 (49 assertions), and full indexd suite 73 library + 44 integration passed. Final HorizonCode TypeScript package typecheck (`packages/opencode`) after P3 changes has only one P6-owned TS2352 Layer-cast diagnostic at `test/server/httpapi-config-features-isolation.test.ts:29`; no P2/P3 diagnostics. Indexd tests do not prove HostKernel authenticated read-grant integration. P3 released Cargo to P1; P3 continues HostKernel-independent phase work. Do not promote P1/P2/P3 to VERIFIED from these checkpoints.

More recent phase-owned checks: P1 recovery receipt recomputation passed 2/2 after exact RED regressions; P2 managed-control passed 39/39, managed client 36/36, and Core AgentProfile/ContextSelection schema tests 9/9 + Core profile/context 2/2; P3 RepoIntel/RepoTools 55/55 (384 assertions), schema/page 7/7 (49 assertions), and indexd 73 library + 44 integration passed. P2 is now taking Cargo for the RepoRead envelope/feature codec + golden digest tests. A final HorizonCode TypeScript package typecheck (`packages/opencode`) is still required after shared edits settle; P3's latest check had only the unrelated P6 isolation Layer-cast diagnostic, before the bounded-render changes.

Latest correction: P2's full kernel library suite passed 319/319 with the authenticated RepoRead codec, negotiated feature, and ContextSelection/profile goldens. P2 released Cargo to P1 for HostKernel context propagation + RepoIntel feature gate. Status remains PARTIAL; typed managed admission/effective ceiling proof, P1 full adversarial acceptance, and P3 authenticated dispatcher/backend wiring remain open.

P1 then passed `authenticated_repo_read_context` 2/2: strict envelope context roundtrip plus zero-mutation denial before RepoIntel dispatch when authorization/feature context is not enabled. This does not prove a successful HostKernel read. P2's Core optional-feature selector passed 15/15 and Goal-review/TUI selectors 8/8; these do not replace the one real managed Attempt/effect/evidence/verifier journey. All three phase owners remain active and PARTIAL.

RepoIntel contract is now reconciled: an optional out-of-body typed `RepoRead { sessionID, locationID }` is carried by the existing authenticated envelope. Principal, canonical root/workspace, and current read scope/policy are HostKernel-derived. The body keeps canonical `queryId`, relative `rootRef`, expected `sourceGeneration`, selector, bounded limits/deadline, and optional opaque cursor; HostKernel resolves the relative root within the registered Location and rejects stale generation pins. Cursors bind to authenticated principal + Session + Location + read scope/policy + generation + expiry.

Exact seam agreed: P2 extends existing private authenticated IPC with optional out-of-body `AuthenticatedRequestContextV1::RepoRead { sessionID, locationID }` and strict codec/fixtures; P1 validates it for RepoIntel, resolves canonical Location/root and Guard read policy, and fences opaque cursors; P3 consumes it without adding caller-controlled identity/scope authority. If HostKernel cannot validate the binding, the read route remains unavailable.

Resources: `/mnt/c` free 20 GB; `/` free 813 GB; `kernel/target` 12 GB; `indexd/target` 269 MB. At the latest observation, P3 released Cargo to P1; P2 is source-only on protocol codec/fixtures. Run only one shared Rust build at a time and preserve caches. Git is `main` with a mixed working tree (150 staged, 191 unstaged, 150 untracked; zero conflicts). Ownership is ambiguous; preserve state and do not stage/commit/push/clean up. Status is PARTIAL / NOT RELEASED. Resume by checking live owners/processes, then continue active full phases and assign a queued phase as soon as a slot frees.

Continuation delta: P3 reports `indexd::repo_structure::{RepoStructureQueryV1, RepoStructurePageV1}` and `RepoIntelGeneration::query_structure(query, provenance)` added; indexd suite is 73 unit + 47 integration green. Structure remains truthfully UNAVAILABLE until a parser is integrated. P2 reports the Goal-review projection now carries/renders accepted capability scope (empty means effects denied), with focused component 5/5 (34 assertions) and TUI typecheck green. P1 is implementing Guard `files.read` scope and HostKernel dispatcher; current source still denies all RepoRead requests, so keep feature/read path unavailable. Parent source review flagged the current binary conversion of authenticated principal into a string; preserve the typed `AuthenticatedPrincipalV1` through dispatch rather than reconstructing identity from a caller string. Active whole-phase owners remain P1/P2/P3; next phase must start when a slot frees. These are owner-reported checkpoints pending parent integration review, not phase completion.

P1/P3 then reconciled the RepoIntel integration types: query `sourceGeneration` is the derived index digest, not the measured workspace source revision. HostKernel must capture bounded files under the authenticated registered Location/current Guard `files.read` scope, build the generation with trusted pins, compare the requested index digest after build, remeasure source revision before returning, and bind the cursor/grant to principal/session/location/scope/policy/generation/query/expiry. Preserve typed `AuthenticatedPrincipalV1` through the reader/dispatcher boundary. The frozen internal dispatcher is being implemented; no successful authenticated query has passed yet.

P3's node-reference selector was RED then GREEN after exact file digest/length and workspace/generation/revision/root/range binding checks; focused suite 4/4, format and diff checks clean. After resuming phase owners, P1 has the Cargo lane (`authenticated_repo_read_context`) while P2 has a Core typecheck lane. `kernel/target` was removed by the user's exact request with `cargo clean`; P1's current build recreated 448 MB. C: free 20 GB, WSL `/` free 824 GB. Git now reports 241 tracked changed paths and 154 untracked paths; preserve the mixed tree and do not stage/publish until exact ownership is established. Whole-phase owners P1/P2/P3 are active again; remaining V1 phases are still queued pending slots.

P1 reports authenticated RepoRead negative/codec selector 2/2 and now preserves typed `AuthenticatedPrincipalV1` through ReaderMessage/HostKernel rather than rebuilding a principal string. No positive RepoRead dispatch exists yet. P2 is implementing the Core SessionSupervisor producer; P3 owns the OpenCode consumer and has been told to continue independent adaptation and coordinate request/response mapping. Current process scan is clear; `kernel/target` 776 MB and `indexd/target` 290 MB. This does not complete any of the three phases.

Contract correction for first RepoIntel query: caller cannot know HostKernel's derived index digest before the first query. Added `repo-intel.v1/ensure_generation` over the same authenticated service: Core sends bounded `RepoGenerationRequestV1`; HostKernel applies Guard `files.read`, securely snapshots, builds/reuses the index, and returns `RepoGenerationPinV1` with `sourceGeneration` (index digest) separate from measured `sourceRevision`, bounded coverage, source kind and expiry. Core then submits `query_structure` with this returned pin. No source bytes or identity/scope authority cross in the request body. Canonical JSON schema and §12.18/30.23/37.22 docs are updated and syntax/diff checks are clean; implementation is still pending, feature remains unavailable.

## 2026-10-19 resumed integration state

Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P3 RepoIntel (all available child slots). P1 reports HostKernel generation leases now bind authenticated principal/session/location/root/policy/revision/query ID, with deadline enforcement, strict UTC parsing, omitted optional fields, and positive/negative ensure→query RPC coverage added; Cargo verification and parent review are still pending, and RepoIntel remains unavailable. P1 is implementing durable principal-bound Location registration and the effective-ceiling proof. P1 also owns the approved P5 guarded outbound HTTP/receipt/cancel boundary. P2 reports prior Core typecheck and focused launch/schema/managed-control/review tests green, but managed admission is still fail-closed pending P1's proof; P2 is carrying the Task-pinned profile revision. P3's latest RepoIntel/RepoTools selectors pass 57/57 and schema passes 8/8; its test found the HorizonCode CLI-host package consumer was not connected to Core's `queryRepoStructure`, and that path now passes a focused 1/1 consumer journey through trusted SessionSupervisor context. P3 still owes real authenticated HostKernel/Core socket and recovery acceptance. P1/P2/P3 remain PARTIAL.

**Security blocker:** P1 source review found `authorize_repo_read_scope` only validates path/revision; `FILES_READ_ID` is not yet used to authorize the authenticated principal. P1 is adding a durable authenticated-principal binding to Location registration (or equivalent Guard grant) and a cross-principal zero-read denial. Until that check and the final positive RPC journey pass, the RepoIntel feature is not negotiated. P2 also identified that Tasks did not persist an accepted profile selection; parent updated the canonical Task contract to pin immutable `agentProfileRevision: ProfileRevisionRef` and added VEO-014. P2 owns Task/OwnerLog/Core/TUI propagation; P1 validates the exact durable pin before minting its opaque effective-ceiling proof.

Parent reran overlay visibility after adding only exact root `.gitignore` exceptions: `compared=6627 changed=313 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` passes. Last resource check: C: free 20 GB, WSL `/` free 824 GB, `kernel/target` 889 MB, `indexd/target` 290 MB. P4–P9, final integrated Security/recovery and product journeys, RC0, final A1/A2, and release qualification remain open. Preserve the mixed tree; no staging, commit, push, or cleanup is safe until ownership boundaries are established.

Latest P3 follow-up: its bounded `repo.tree` suite passes 10/10 (29 assertions), including symlink skip and external-directory denial before enumeration; RepoIntel/RepoTools remain 57/57 and schema 8/8. Its latest HorizonCode TypeScript package typecheck (`packages/opencode`) has only the known P6 Layer-cast diagnostic. P3 released TypeScript to P2 and continues its phase; P2 owns the next Core/profile-pin checks, and P1 owns the single Cargo lane after coordination.

## 2026-10-19 continuation delta — principal propagation

P1/P2/P3 remain the active whole-phase owners. P1 will preserve legacy location registration only as unbound and without RepoIntel authority; managed/profile and RepoIntel require typed ServerAuth and durable HostKernel-derived principal binding. P2 is authorized to make narrow trusted-principal context plumbing across Core callers (including context-only LLM runner plumbing if required) while making no P6 behavior changes. Cross-subject/forged profile-owner attempts must deny before OwnerLog mutation. Current code, tests, and final gates remain incomplete; see `CURRENT_RUN.md` for disk/build/Git snapshot and ownership caveats. P4–P9 remain queued; final integrated acceptance and release are NOT VERIFIED.

P1 added the persisted profile-owner-binding digest to `EffectiveCapabilityCeilingProof`; derivation requires matching accepted Task/profile owner and recomputes User owner from authenticated Attempt subject before capability intersection. Keep cross-subject mismatches fail-closed and prove zero preparation/effect. Rust acceptance is pending stable P2 managed-control API. See `CURRENT_RUN.md` for the active roster and resources.

RepoIntel overlays remain an explicit V1 blocker per §30.22: P3 is adding opaque `overlayRef`/`overlayDigest` contract handling; P1 owns a HostKernel-issued bounded ref lifecycle bound to authenticated principal, Session, Location, base generation, source revision and read-policy digest. There is no current Core snapshot producer. P2/P4 must provide a genuine buffer owner; do not accept query/tool/model bytes or P7 artifact refs as snapshots. Until integrated tests prove two owners get distinct overlays and stale writes deny, this acceptance remains NOT VERIFIED.

P1 has wired authenticated Task owner binding into HostKernel ingress and Guard ceiling derivation, with a regression for same-owner User positive, cross-subject/OS-only denial, and Builtin positive. `rustfmt` passed; Cargo acceptance is pending a coordinated exclusive build lane after P2 confirms managed-control API stability.

Overlay ID contract detail: use host-generated opaque `ovl_[A-Za-z0-9_-]{16,128}` refs; the optional query ref is only a lookup handle, while HostKernel authenticates ownership and validates `overlayDigest` provenance. No genuine Core snapshot producer exists yet, so mint and live distinct-overlay acceptance remain unavailable/not verified.

P1 also keyed RepoIntel generation leases by request/query ID to prevent same-owner concurrent pin overwrite, with a two-pin matching-query regression. Rustfmt passed; Cargo verification is pending P2's managed-control source stability.

P3/P1 source now carries optional RepoIntel query `overlayRef` and node/page `overlayDigest`; HostKernel strictly decodes/preserves it and fail-closed rejects unsupported overlay refs before generation lease lookup/filesystem collection. Base-only passes no overlay into indexd. No mint producer exists; live distinct-overlay tests remain open. Cargo is still held for the P1/P2 managed-control integration once P2 stabilizes Rust source.

P2 reports stable `managed_control.rs` owner-binding persistence and an Alice-profile/Bob-executor zero-mutation denial. The single Cargo lane has been handed to P1 for focused compilation/acceptance; P2/P3 remain source-only until release.

Resource correction: a fresh scan found an active HorizonCode CLI-host package `tsgo` typecheck (PID 84283 family, started 14:15 UTC); P1 holds Cargo until it exits. Do not start another heavyweight check or kill it; owner/results are being identified. Disk remains C: 20 GB free and WSL `/` 824 GB free.

HorizonCode TypeScript package typecheck (`packages/opencode`) exited 2; P3 has no owned diagnostic. P2 owns the principal-context propagation failures, including detached SessionRunCoordinator→SessionRunner; P6 owns one Layer-cast fixture diagnostic at `packages/opencode/test/server/httpapi-config-features-isolation.test.ts:29`. P1 now uses Cargo for owner mismatch composition, then releases to P3 repo_structure. P2 must not start a concurrent TypeScript check.

P1 owner-mismatch Cargo selector did not reach tests: compile stopped on duplicate P3 `BufferOverlay::digest` / `base_generation_digest` definitions in `indexd/src/lib.rs` (near lines 535/540 and 855/847). P3 owns the fix and Cargo lane; P1 reruns after P3 releases. This is NOT test evidence.

P3 removed the duplicate BufferOverlay methods; `indexd` repo_structure Rust tests pass 6/6, schema 9/9 (67 assertions), RepoIntel/RepoTools 60/60 (410 assertions), JSON schema valid. P3 remains in progress pending HostKernel auth integration, overlay mint producer/isolation, stale/cancel/restart and full phase evidence. Cargo has been handed to P1 for the managed profile-owner proof rerun.

P1 Cargo retry reached kernel compile but still exited 101 before tests: P2 E0365 at `managed_control.rs:22` (public re-export of crate-private ProfileOwnerBindingV1) and P1 E0308 at `host_kernel.rs:10282` (`Vec` passed to array-only `map_value`). Cargo is idle/released. Owners are fixing their respective files source-only; rerun once both report stable.

P2 fixed the profile type visibility re-export; P1 fixed HostKernel `map_value` construction (rustfmt check passes). P3 reports repo_structure 6/6 and released Cargo. P1 is rerunning the owner-binding selector; await its exact test result.

P3's focused overlay evidence: OpenCode RepoIntel test 51/51 and schema test 9/9 (67 assertions). Without request overlayRef, response page/node overlayDigest must be absent; with a ref, page digest is required and every node digest must match (reject base-only downgrade). Host unsupported overlay is typed `capability_unavailable`; stale generation maps to `generation_mismatch`. P3's foreign-base Rust test awaits P1 Cargo release; live mint/producer still absent.

P1 owner-binding focused Rust selector passed 2/2 (323 filtered): Guard mismatch before ceiling mint and managed Alice/Bob mismatch before mutation. P1 owns two compile warnings (`unused BTreeSet`; public method returning crate-private receipt) and must rerun on the warning-fixed revision. Cargo is with P3 for updated overlay/repo_structure tests.

Latest post-build disk check: C: 20 GB free, WSL `/` 823 GB free, `kernel/target` 1.5 GB, `indexd/target` 292 MB. No build process active in the instant scan; preserve caches.

Overlay audit correction after P2 Core additions: parent added exact ignore exceptions for `packages/core/src/session/run-coordinator.ts` and `packages/core/src/session/runner/index.ts`; audit now reports 6,627 compared, 315 changed, zero hidden changes/new source/stale exceptions; diff check is clean.

RepoIntel overlay ordering blocker: Core currently may run `ensure_generation` before HostKernel rejects unsupported `overlayRef`, so file collection can precede denial. P2 owns an early Core capability-unavailable gate + zero-dispatch test; P1 HostKernel denial remains defense-in-depth. Do not claim denial-before-read until that passes.

P1 fixed both reported warnings (unused import removed; `ensure_repo_generation` narrowed to `pub(crate)`) and added a HostKernel overlay denial regression that renames the source after pinning; capability-unavailable must occur without remeasurement/collection. Rustfmt is clean; rerun awaits P3 Cargo release.

P3 post-overlay Rust selector passed 6/6, including foreign-base denial, and Cargo is explicitly released. P1 takes Rust for warning-fixed owner binding and pre-collection overlay denial; next P2 gets TypeScript for Core principal propagation after release.

P1 warning-fixed Rust selectors pass: profile owner mismatch 2/2; authenticated generation pin/identity/scope/expiry + overlay denial before source remeasurement 1/1. Targeted warnings are gone; remaining warnings are unrelated. Cargo released. Parent updated §30.22 to reconcile overlay semantics: an explicit overlay request must fail typed unavailable/stale with no nodes and cannot downgrade to base-only; partial base-only results are only allowed for queries that never requested an overlay.

P1 released Cargo; P2 takes the TypeScript lane for Core trusted-principal plumbing and early overlayRef denial. P3 stays source-only, then gets Cargo for RepoIntel overlay integration after TS release. Do not overlap.

Managed admission is still fail-closed: P1 confirms `managed_admit` returns `capability_unavailable` before OwnerLog open and the effective ceiling proof has no production consumer. P2 effect dispatch needs real typed workspace/resource lease producers (P8) plus P1 live Guard resolution. P8 remains queued as a whole-phase owner for the next available slot; do not treat the proof type or tests as wired runtime authority.

Real-socket RepoIntel still cannot negotiate authenticated context because `hz-kernel` supported_features omits `repo-intel.read-context-v1`. P1 is adding a readiness-gated feature offer and Linux socket positive/negative matrix; per-connection enablement and peer negotiation remain mandatory. Keep unavailable until all tests pass.

P3's overlay schema validation passes for five shared records; three malformed cases are rejected (bad ref, node digest without page digest, digest on a base page). The durable fixture covers overlay provenance. This does not prove a live mint/transport path.

P3 source audit found no production Core/OpenCode unsaved-document snapshot owner; only RepoIntel DTO/input code exists. P1 overlay mint stays unavailable. VEO-005 two-live-overlay acceptance requires a genuine P2/P4 buffer producer; P3 is checking reusable P4 LSP document synchronization. Keep the blocker explicit.

P3's exact producer audit: Core supervisor only forwards overlayRef; OpenCode LSP `notify.open({path})` reads disk and owns no unsaved text input; LSP query APIs expose no buffer snapshots; broker pins service identity only. Legacy RepoIntel tool inputs accept caller bytes and cannot mint owner authority. No existing V1 unsaved-buffer owner exists; a new authenticated producer is required for live overlay acceptance.

P2 Core typecheck after principal propagation reports exactly three errors, all same cause: `SessionSupervisorError` used as value at session.ts:390/415/467 but imported type-only. P2 is fixing import and rerunning; no other diagnostics in that run.

P2 Core typecheck is green (`cd packages/core && bun run typecheck`, exit 0). TS lane released. P1 takes Cargo for readiness-gated real socket RepoIntel acceptance; P2 continues full managed acceptance, not complete at typecheck.

Core now early-denies unsupported `overlayRef` through `withRepoIntelOverlayGate` before principal resolution, Location registration, or ensure-generation. P2 must prove zero registration/ensure calls. P4 LSP document map is loaded from disk and has no authenticated snapshot producer; two-live-overlay acceptance remains blocked.

P1 real-socket selector compiles but fails base ensure→query with `invalid_repo_query` at `hz_kernel_process.rs:712`; this is NOT acceptance. P1 is diagnosing the strict DTO mapping. P3 reran overlay-aware repo_structure 6/6 and released Cargo. Do not weaken schema/validation to mask the mismatch.

Socket failure root cause was a malformed empty positive selector fixture, which strict indexd validation correctly rejects. P1 changes fixture to `includeCallers: true` and reruns; no production validator relaxation.

A brief Cargo/TypeScript overlap was detected. P1 canceled its own retry (exit 130); no Cargo remains, the OpenCode `tsgo` PID 90418 continues and owner is being identified. Nothing unrelated was killed. Wait for the TypeScript lane to release before P1 retries.

HorizonCode TypeScript package typecheck (`packages/opencode`) PID 90418 is P3-owned. It remains active; P3 will report/release TS, then P1 retries Cargo. Do not overlap.

Latest P3-owned HorizonCode TypeScript package typecheck (`packages/opencode`) exited 2 and TS is released. P3 owns two repo-intel test typing errors (lines 537/545); P2 owns trusted-principal propagation diagnostics in workspace/VCS/managed-control/apply_patch/shell/task/write/session handlers; one P6 config isolation fixture cast remains. P1 takes Cargo for the corrected socket selector; no overlap.

P1 Linux socket selector passes 1/1 (8 filtered): negotiated ensure→query, foreign owner, overlay denial before source collection, stale pin, and non-negotiated peer. Profile-owner mismatch selector passes 2/2 (323 filtered). Cargo released. Phase acceptance/release remains open; unrelated existing Rust warnings remain.

Release typecheck target is root `bun run horizoncode:typecheck` (HorizonCode CLI-host package + TUI + Core sequentially), not just the upstream HorizonCode CLI-host package package check. P3's RepoIntel test now passes 51/51 (385 assertions); await P2 source fixes, then run the integrated HorizonCode script.

Core→HostKernel live socket test currently fails canonical page decoding: HostKernel emits uppercase freshness, schema requires lowercase. P1 owns serializer mapping/regression; P3 reruns `bun test test/repo-intel-live.test.ts` after correction. This is not accepted until green.

P2's new Core overlay gate/coordinator sources were exposed through exact root ignore exceptions. Latest overlay audit: 6,627 compared, 316 changed, zero hidden changed/new source/stale unignore; `git diff --check` clean.

P1's corrected socket selector passes 1/1 with canonical page assertions (`UNAVAILABLE`, `unknown`, `unavailable`, `none`, no nodes). Serializer casing fixed; Cargo released to P3 to rerun Core live socket test. Do not count the prior failure as acceptance.

P3 Core live RepoIntel test now passes 1/1 (9 assertions) for authenticated ensure→query, Session/Location context, lineage validation, and truthful parser-unavailable page. P1 separately covers socket negatives. P3 remains incomplete pending integrated HorizonCode TypeScript package typecheck (`packages/opencode`) and the missing real snapshot producer/two-overlay journey.

Core live RepoIntel consumer is green (1/1, 9 assertions). P3 takes Cargo for full indexd regression while P2 remains source-only; after release P2 takes `horizoncode:typecheck`. No overlap.
## 2026-10-19 continuation (14:32 UTC)

V1 remains PARTIAL / NOT RELEASED. Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, and P4 LSP/DAP/REPL (P3 released its slot as PARTIAL). P2's single integrated `bun run horizoncode:typecheck` is running after fixing three diagnostics; do not overlap another TypeScript build. P1's corrected shell-interpolation fixtures await that lane. P4 has started with exclusive LSP/DAP/REPL module/test ownership and is auditing the authenticated buffer-source seam; it must keep effects unavailable until P1's Guard/confinement dispatcher passes.

Latest P1 Linux terminal containment selector passed 2/2 (workspace write allowed; outside-metadata and host-network denied). P3 current evidence: indexd 123/123, schema 9/9, RepoIntel/RepoTools 61/61, adapter 51/51, Core authenticated socket consumer 1/1, HostKernel socket 1/1, owner mismatch 2/2. P3 remains PARTIAL: approved parser dependencies cannot provide production TS/Rust structural results; no authenticated immutable-buffer producer exists, so overlay references fail closed. Query→stale `files.patch` acceptance remains unverified and P1-owned.

Parent overlay audit: 6,627 compared, 316 changed, zero missing/hidden/stale; `git diff --check` clean. `/mnt/c` has 20 GB free; WSL `/` 823 GB; Rust targets are 2.3 GB (kernel) and 292 MB (indexd). Main worktree only; mixed staged/unstaged/untracked ownership remains ambiguous, so no stage/commit/push or cleanup performed. Preserve state and use one heavy build lane.

## 2026-10-19 update (14:48 UTC)

P2's integrated `bun run horizoncode:typecheck` now passes HorizonCode CLI-host package, TUI and Core after threading the authenticated ServerAuth principal into both HostKernel approval calls. P2's focused Core coordinator/overlay selectors pass 2/2 (8 assertions); the trusted provider-tool runner selector passes 1/1 (5 assertions). P2 remains PARTIAL on managed reviewer/verifier/current-workspace evidence, TUI review delivery and lifecycle recovery.

P1 root-caused the shell-interpolation lease failure to the missing trusted principal in those two HostKernel calls. P1 is rebuilding `kernel/target/debug/hz-kernel` before rerunning the allow/deny approval journey; no production lease change is justified unless that rebuilt-binary test still fails. P4 returned PARTIAL with 208/0 LSP/DAP/REPL tests (724 expectations), Prettier and diff checks clean; the effects, authenticated editor ingress and real-project journeys remain blocked/unverified. P8 is the next active whole-phase owner and is tracing durable owner/lease lineage without treating process-local pool state as authority. All effects remain fail-closed until P1/P2/P8 proofs pass.

Active owners are P1/P2/P8. Parent overlay audit: 6,627 compared, 316 changed, zero hidden/stale; C: `/mnt/c` has 21 GB free; WSL `/` 823 GB; kernel/indexd targets 2.2 GB/292 MB. Main worktree only; preserve mixed staged/unstaged/untracked state. No exact-scope commit, push or cleanup has occurred. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 post-restart continuation — log forensics + owner quorum

The hosting server restarted 15:02:49 UTC after ~25 h down. Log forensics (`~/.local/share/opencode/log/opencode.log`): 32 `serve --service` starts since Oct 17 with zero crash/panic/OOM entries; the lifecycle is CLI/app-driven (`background service starting reason=missing`, one explicit `opencode service restart`, one client `Timed out waiting for the background service`, `watcher stopped`→new-start cycles ~1 s apart) with 11 client `Event stream stalled` disconnects. Aggravators: 2.13 GB `opencode.db`, 20–40 s boot with all MCPs, WSL memory pressure (7.9 GB VM, swap 1.6/2.0 GB busy). No code lost.

Owner sessions after restart: P1 terminal/shell (`ses_eb1026206ffenPuA1w8lTObTOu`) and P2 client/TUI (`ses_eb1026152ffe7T8ECjWnKpDSSN`) auto-resumed at 15:03:06 and stayed mid-turn; P1.3 Guard (`ses_eb4ead3d5ffeRPhH6sBFf5yh4m`) and P2 managed (`ses_eb4ea6f76ffeWOqS08OuA9sNF5`) hit a provider usage limit during startup drain, were re-prompted at 15:09:29 UTC with the implementation-first direction, and are actively working. Tool-suite upgrade research closed idle at 15:03:46 (WS-TOOLRES complete); P1-ORIG assigned set recorded COMPLETE (zero child effects). No staging/commit/push.

### 2026-10-19 15:41 UTC — concurrent Codex writer fleet (deconfliction)

A second, user-run Codex orchestration (codex-tui; fork of `01a14f8d…`) is editing this same checkout in parallel and maintains its own CURRENT_RUN entries. Codex owners: P8 `14:47-53` (kernel worker_*/worktree_lifecycle/perf), P7 `15:13-56` (TUI/session-event/artifacts), P6/S1 `15:13-52` (provider/doctor/dialogs), P5 `10:53-04`+`14:59-27` (websearch; dialog fix 15:25–15:28), P4 `15:34-50` (LSP/DAP/REPL), Codex P1/P2 started 15:34:40/46 (kernel). OpenCode lanes: P1.3 = `tool-batch.ts` + `core/session/supervisor.ts` + `kernel/effect_host.rs`; P2 = `managed_control.rs` + `host_kernel.rs`; P1-TERM = `terminal.rs` + core `pty.ts` + pty/shell tests. HostKernel/hz-kernel currently have two concurrent writers (OpenCode P2 + Codex P1) — arbitration raised to the user at 15:41 (recommended: OpenCode keeps kernel P1/P2; Codex keeps P4–P8). Before dispatching OpenCode owners into P4–P8 paths, check `~/.codex/sessions/2026/10/19/` rollout mtimes for active Codex writers. Keep one heavyweight Cargo lane.


### 2026-10-19 15:46 UTC — verifier contract and P4 visibility integration

- Active whole-phase owners remain P1 Guard/ExecutionHost, P2 managed vertical, and P4 LSP/DAP/REPL (three child slots occupied). No phase is complete.
- Parent reviewed the live managed-verifier source and found its process binding lacked a Task Attempt. P1 confirmed §14.3/§12.6 have no verifier exception; the unscoped path is now explicitly unavailable. Parent ruled that V1 uses one coding Task/Attempt kept EXECUTING through a separately approved read-only verifier EffectIntent under the same Attempt, then settles only after typed evidence and fresh workspace revision are durable. Crash/cancel/lost receipt/stale revision/partial capture after possible dispatch remains UNKNOWN and cannot relaunch. Design recorded in arch_V1 §§3.22, 4.13, 12.19, 14.3 and 37.22.
- P1 accepted P2's private `record_attempt_effect_receipt` proof contract and is implementing bounded exact per-effect Attempt lineage. A private `bind_attempt_verifier_intent` persists the trusted verifier profile/executable/criteria/arguments/workspace pins before Guard dispatch. Multi-effect restart settlement remains fail-closed pending P2's durable receipt model.
- P1 source-only progress: HostKernel opens/replays the worker OwnerLog at startup under SupervisorLease epoch and forces fan-out Closed; shell output now distinguishes artifact fidelity, preview truncation and artifact truncation. The P1 generic supervised-process broker is being defined for P4. No tests/builds/typechecks/audits were authorized or run by these owners.
- P2 added `POST /experimental/control-plane/goal-run-plan` schema and started durable plan projection via existing managed Core RPCs; Tasks stay unready and no Attempt/effect is admitted. Parent flagged the draft revision as JS number instead of canonical DecimalU64 string, and the HTTP principal fallback to `host_os`; P2 is correcting those and must enforce accepted durable SpecVersion plus canonical bounded IDs before handler/TUI wiring.
- P4 source-only progress: LSP edit batches bind workspace revision and effect-intent digest; DAP uses host-issued process refs rather than PIDs and quarantines UNKNOWN; REPL cancellation/UNKNOWN quarantines state and forbids silent generation replacement. Execution remains unavailable pending P1's typed supervised-process broker and OS confinement. P4 reported `packages/opencode/src/lsp/edits.ts` and its test were hidden by the overlay; parent added only exact `.gitignore` exceptions, and Git MCP now lists both paths.
- A brief unowned Cargo selector process (`host_terminal_process`/`host_terminal_events_process`) appeared in a 15:42 scan and exited before ownership could be established. P1/P2/P4 each confirmed they did not start it. It is not counted as evidence; all owners remain on the implementation-first hold.
- Resource snapshot: C: `/mnt/c` 21 GB free; `kernel/target` 2.7 GB; `indexd/target` 292 MB; one main worktree, branch `main` 12 commits ahead with mixed staged/unstaged/untracked changes. Preserve all state. Do not stage, commit, push, clean or prune.
- Next queued whole-phase owner when a slot opens: P8 (worktree/resource/worker/RC0 integration needed by P1/P2), followed by P7 artifact/rewind integration, then P6/P5 and remaining P3/P9 work according to dependencies. Release/typecheck/security/platform verification stays deferred until source implementation closes.

## 2026-10-19 15:52 UTC — active managed-process contract handoff

The implementation-first V1 wave continues under P1/P2/P4 whole-phase owners; no phase or release gate is complete. No validation workloads are authorized until implementation scope closes.

The shared managed process boundary is now aligned on the exact private `ManagedAttemptScopeV1` wire envelope: Goal/Run/Task/Attempt IDs, canonical-decimal owner epoch and managed revision, authenticated Location/Session, current workspace revision digest, and Rust-owned delegation-binding digest. Each effect separately binds its effect ID, durable OwnerLog revision, capability and one-use lease digest. P1/P2 agreed that observed verifier output must bind the same live Attempt and exact criterion effect IDs; the HostKernel's fresh workspace revision is authoritative. The verifier remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`) pending real guarded dispatch and receipts.

P4 has added `locationID` ownership to DAP/REPL effect and session records. Their workspace revision pins remain independent from process generation, owner epoch and (for REPL) source generation. All process/effect paths still requiring P1 Guard/confinement stay unavailable.

At this checkpoint P1/P2/P4 are active; P8 is first queued, then P7 and remaining P3/P5/P6/P9 work. C: `/mnt/c` had 20 GB free, `kernel/target` 2.7 GB, `indexd/target` 292 MB; only the main worktree exists. The tree is mixed staged/unstaged/untracked and `main` is 12 ahead. Preserve it; no publication or cleanup was performed.


## 2026-10-19 15:53 UTC — managed receipt source delta

P1 has source-wired HostKernel terminal settlement to record each managed effect's exact Attempt receipt edge, principal, epoch, Location/Session, bound OwnerLog revision, lease digest, target receipt and before/after workspace revisions. Unknown launch/exit/receipt states persist UNKNOWN and cannot be retried. P1 also added host-derived Attempt and per-criterion effect IDs to verifier observations/journal. P2 tightened principal matching and requires all coding receipts SUCCEEDED at the exact source revision before verifier intent; verifier output must preserve that revision. The HostKernel verifier call-site still uses an incompatible legacy begin sequence, so verifier dispatch and finalization remain disabled. These are source-only changes, not built/tested or phase acceptance.

A broad `git diff HEAD --stat` invocation exited with SIGBUS while reading the large shared dirty tree; no file mutation or validation workload followed. C: remained at 20 GB free; no Cargo/Bun/TypeScript test process was active. Avoid broad diff output and preserve the mixed tree.

### 2026-10-19 15:56 UTC — managed Attempt revision-chain ruling and open reducer fix

- Source review confirms HostKernel derives the current workspace head from the immutable Attempt admission revision and prior ordered SUCCEEDED effect receipts, while also recomputing the registered workspace root before dispatch. The aggregate OwnerLog expected revision is separate from each effect edge's immutable bound revision.
- A reducer gap remains: `ManagedControl::RecordAttemptEffectReceipt` was still comparing each coding effect's before revision directly to the Attempt base. P2 acknowledged and is implementing reducer-side ordered receipt-chain validation; P1 owns HostKernel chain enforcement. Until both sides agree and the chain is integrated, verifier dispatch and finalization stay disabled.
- Contract was reconciled across arch_V1 §§3.22, 12.19, 14.3 and 37.22: immutable admission provenance; exact predecessor-linked receipt chain; serialized V1 mutations; read-only verifier before=after=current head; failure/UNKNOWN/cancel/epoch change/out-of-chain edit fences; no caller rebase. No tests/builds/typechecks were run.
- P1/P2/P4 remain the active whole-phase owners; all V1 phases remain PARTIAL / NOT RELEASED. C: `/mnt/c` has 20 GB free; targets are 2.7 GB/292 MB; one main worktree; mixed staged/unstaged/untracked state and 12 commits ahead. Preserve all ownership; no staging, commit, push, cleanup or prune.

### 2026-10-19 15:57 UTC — verifier intent/lease ordering contract

The verifier edge and immutable intent must be durable before Guard lease issuance. The intent contains the trusted profile/executable, criterion/arguments and current workspace chain head, but not the one-use lease digest. Refresh managed scope after that append; Guard/approval then issues a lease bound to the exact Attempt edge, immutable intent digest and live revision/workspace fence. Do not mutate the managed OwnerLog with the lease digest before dispatch; EffectHost owns durable one-use consumption and the HostKernel-authenticated settled receipt records the digest. Authenticated distinct reviewer approves; trusted verifier profile principal owns the child and receipt. Any pending OwnerLog/workspace change fences authorization. This follows the existing §14.3 ordering and resolves the revision cycle; verifier stays disabled until source wiring matches it. P1 was instructed to keep direct Core bypass closure in scope; P2 is fixing reducer predecessor-chain checks; P4 keeps DAP unavailable until a correctly typed non-terminal process contract exists. No tests/builds/typechecks were run.
### 2026-10-19 18:26 UTC — source-led subagent architecture audit

The live child roster is empty except for the parent; the user's stop-all-subagents
instruction remains active. Do not restart agents. The implementation-first hold also
remains active: no tests, builds, typechecks, audits or provider probes until implementation
closes.

The source review covered OpenCode `tool/task.ts` and the Codex agent-tree lifecycle across
spawn, runtime, mailbox, completion, resume, residency, registry, child configuration and
multi-agent tool handlers. Horizon's relevant distinction is now explicit: direct-session
children use the existing Core Session owner and need no Goal; managed children use Rust
Task/Attempt/DelegationBinding and independent verification. The doc correction is in
`arch_V1/03-FLOWS.md` §3.5, `29-AGENTS-SKILLS-HOOKS-MCP.md` §29.5,
`37-RUNTIME-SERVICE-LLD.md` §37.9, derived atlas §45.8, and source decision §42.12.

**Question pending:** the canonical `SubagentDeliveryV1` machine schema is lane-ambiguous and
does not define `authorityDigest`. User was asked to choose one lane-tagged envelope or
separate direct/managed delivery schemas. No schema change is made pending that decision.

All P1–P9 implementation, integration and final release gates remain open as last recorded;
this turn changes architecture docs only and supplies no implementation/acceptance evidence.
Current `/mnt/c` free space is 60 GB (87% used); only the main worktree exists. Git remains
`main` 12 commits ahead with extensive mixed staged/unstaged/untracked work. Preserve all
state; no staging, commit, push, cleanup or prune was performed.
### 2026-10-19 18:27 UTC — P1 confinement source/doc reconciliation

Source inspection found §14.5 still claimed `horizoncode-sandbox` was absent and described
macOS Seatbelt support. The live tree has `kernel/Cargo.toml` depending on the crate and
HostKernel terminal/non-PTY launch preflights in `kernel/src/terminal_process.rs` that
require the Linux backend's filesystem, egress-denial and process-tree guarantees. Updated
§14.5 and the §20.12 source map. This confirms code-present wiring for these process routes
only; it does not prove universal Guard coverage or final containment acceptance.

The sandbox API supports deny-default or host-shared network, not destination allowlists.
§14.5 now keeps networked workspaces dependent on a separate Guarded, destination-scoped
proxy/service and unavailable without that enforcement. Non-Linux confined profiles remain
unavailable. No tests/builds/typechecks were run. Full V1 remains PARTIAL / NOT RELEASED.
### 2026-10-19 18:28 UTC — resource-limit guarantee needs a V1 ruling

`horizoncode-sandbox` reports `ResourceLimits` unsupported; current Linux confinement
does not impose CPU/memory/FD quotas. Terminal and stdio preflight do not require that
dimension. Existing process slots, time/output bounds and Rust resource observations are
not OS-enforced quotas. §14.5 now records this exact source state and requires fail-closed
behavior whenever a profile requests the dimension.

Asked the user whether V1 effectful workers must require OS-enforced CPU/memory/process
count caps, or keep this dimension unavailable and rely on admission/monitoring only. This
default-policy decision is pending; no implementation change is made. P1/P8 resource work
and V1 acceptance remain open.

### 2026-10-19 — current source and resolved decisions

The user resolved the single-envelope delivery choice and resource policy. The lane-tagged
`SubagentDeliveryV1` schema and architecture now distinguish direct Core parent/profile scope
from managed Rust `DelegationBindingV1`/Attempt scope; `authorityDigest` has a canonical,
domain-separated BLAKE3 definition. Runtime Rust/TypeScript decoders and cross-language
fixtures are still required. Resource profiles that require OS CPU/memory/process-count/FD
limits remain unavailable until enforced by the OS; admission/monitoring does not count as
hard quota enforcement. §04 also records lane-bound child progress and redacted search-route
attempt projections with no replay-triggered network dispatch. A browser-safe TypeScript
`SubagentDeliveryV1` decoder is now source-present; Rust parity, fixtures and typechecking
remain open.

P5 cascade now records auth 401/403/407 per route and continues only to another explicitly
enabled/configured route; other non-rate-limit 4xx errors stop. Source and its regression
expectation changed, but tests were not run. `WEB_SEARCH_GUARD_READY=false` and production
dispatch remains unavailable. The user-directed implementation-first hold remains: no tests,
builds, typechecks, audits or provider probes before implementation closes. All P1–P9 and
release work remain PARTIAL / NOT RELEASED. The user stopped all subagents; live roster empty.

### 2026-10-19 — Rust delivery-decoder source delta

Added `kernel/src/subagent_delivery.rs` and exported the module. It strictly decodes the
lane-tagged bounded MessagePack delivery envelope, enforces lane-specific direct/managed
authority fields, and recomputes the domain-separated authority digest. This source is not
yet connected to a delivery RPC/lifecycle and proves no live authority. The decoder exposes
explicit comparisons against authenticated Core Session/profile claims or a live Goal plus
immutable `DelegationBindingV1`; these helpers do not replace Guard. Golden cross-language
fixtures, runtime integration, typecheck/build/tests and final acceptance remain open. The
workspace remains mixed staged/unstaged/untracked; do not stage, commit, push, or clean while
ownership is ambiguous. No validation workload was run.

### 2026-10-19 — P2 reviewer-path source reconciliation

Re-read the current Goal-review route, managed-control client, authenticated private
Core→HostKernel RPC dispatch and Rust durable reviewer reducer. The distinct reviewer path is
source-wired: middleware-derived ServerAuth is carried outside the operation body; Rust
assigns the reviewer durably and enforces proposer/reviewer separation and stable assignment.
This corrects the older status wording that said the production reviewer channel was absent.
Real-socket positive and spoofed-identity negative evidence remains open; P2 is not promoted
to TESTED or VERIFIED.

### 2026-10-19 — direct child profile authority ruling

Core Config's immutable `AgentProfileV2` is canonical for direct-session and managed child
profiles. Current `TaskTool` still selects through legacy `Agent.Service`, so the agreed direct
delivery claims cannot yet truthfully bind what executes. Keep direct delivery unavailable
until V2 selection and runtime projection are wired: the selected profile must drive model,
harness, instructions, tools and the effective parent-intersected permission scope before
its revision/digests are pinned to the child Session and Direct Attempt. Preserve
`subagent_type` only as a stable compatibility selector/alias to that revision; legacy Agent
configuration may be migration input, but must never independently authorize the child.
Resume the exact immutable revision or fail closed; do not inherit an unpinned parent model or
silently select latest. The release tracker marks this shared P1/P2 implementation gap and
VEO-017 acceptance. Continue to call the integrated product check `bun run
horizoncode:typecheck`; package-local results are HorizonCode TypeScript checks with an
explicit package path. No tests/builds/typechecks were run. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 19:01 UTC — full V1 implementation resumed

The user resumed V1 after the earlier stop-all-agents checkpoint. Current whole-phase owners
are P1 Guard/ExecutionHost (`p1_guard_resume_1019`), P2 managed vertical plus direct-child
AgentProfileV2 Task migration (`p2_managed_resume_1019`), and P4 LSP/DAP/REPL
(`p4_lsp_dap_repl_resume_1019`). P1 owns kernel Guard/HostKernel/process files; P2 owns
TaskTool/profile projection and managed-control/Goal/review files, with `host_kernel.rs`
reserved to P1; P4 owns LSP/DAP/REPL package paths only. P3/P5/P6/P7/P8/P9 are queued as
slots open. Parent owns integration and release-status reconciliation.

The implementation-first hold remains: no tests, builds, typechecks, audits, provider probes,
or performance runs before implementation scope closes. No phase is verified. Git MCP reports
`main` at `6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind, 150 staged, 228
unstaged, 171 untracked, no conflicts, one worktree. Preserve all existing ownership; no
stage/commit/push/cleanup/prune. C: `/mnt/c` has 60 GB free (87%); `node_modules` is 2.5 GB.
No build/test process or source verification was running at dispatch.

### 2026-10-19 19:09 UTC — profile authority and P4 launch boundary resolved

The first three child turns hit an account usage limit and stopped. Replacement whole-phase
owners are active in the three available child slots: P1 Guard/ExecutionHost
(`p1_guard_full_resume`), P2 managed vertical plus direct Task profile migration
(`p2_managed_wave2_1019`), and P4 LSP/DAP/REPL (`p4_lsp_dap_repl_wave2_1019`). P1 exclusively
owns Rust protocol/HostKernel/process work; P2 owns Core/TaskTool, `managed_control.rs`, Goal,
review and TUI; P4 owns only LSP/DAP/REPL package modules/tests. P3/P5/P6/P7/P8/P9 wait for a
slot. User's implementation-first hold remains: tests/builds/typechecks/audits/provider probes
and performance commands are deferred until V1 implementation closes.

Reconciled the direct child profile authority question against §§12.11, 17, 29.2/29.20 and
37.9. Core Config's immutable `AgentProfileV2` revision is authoritative for direct and managed
children. `subagent_type` is a selector only when it maps to one stable profile ID/revision;
legacy Agent data cannot drive runtime execution under a decorative V2 digest. Core sends
authenticated exact `profileSelection` plus digest-free definition; HostKernel reuses its
existing strict decoder and BLAKE3 canonical digest helper, validates the exact tuple, and
constructs/returns the direct Attempt scope. There is no caller-supplied scope tuple. P1 owns
Rust `protocol.rs`/HostKernel; P2 owns TS/Core Task projection and durable direct Attempt record,
receipt, event and recovery. The scope adds `profileID`, positive canonical `profileRevision`,
and BLAKE3 `profileDigest`; existing `permissionsDigest` remains the effective permission-rule
digest, and `scopeDigest` continues to bind all dispatch facts.

For P4, the user approved projecting existing trusted Core Config into an immutable HostKernel
launch profile through the **single existing ExecutionHost supervisor**. There is no second
supervisor or independent mutable launch registry. HostKernel validates/resolves the profile;
P4 callers cannot authorize with raw executable, argv, cwd, env, PID or process handle. Project,
plugin and external launch definitions remain unavailable pending explicit trust resolution.
Updated architecture owners §§14/17/20/32/37 and derived flow atlas §45. P4 source review also
found a REPL scope-type mismatch, DAP `variables` cannot be assumed passive, and LSP
`notify.open` reads workspace files in the app process; their source fixes are underway. These
are code changes only, with no validation run.

No phase is VERIFIED; all P1–P9 source implementation and final release gates remain open.
Git status is mixed and ownership remains ambiguous: `main`, 12 ahead, 150 staged, 228
unstaged, 171 untracked, zero conflicts. Preserve it; do not stage/commit/push/clean. Last C:
disk check was `/mnt/c` with 60 GB free; check again after the next build-heavy wave.

## Latest source reconciliation — 2026-10-19 19:18 UTC

This supersedes the older no-owner checkpoint above. P1 Guard/ExecutionHost, P2 managed
vertical/direct AgentProfileV2 child migration, and P4 LSP/DAP/REPL are active whole-phase
owners in the three actual child slots. No tests, builds, typechecks, audits, provider probes
or performance runs are authorized until source implementation for V1 closes. Git is
`main`, 12 commits ahead with broad mixed staged/unstaged/untracked changes; preserve all
ownership. C: is monitored at `/mnt/c` (60 GB free at the latest reading).

P1 has source-added `repo-intel.v1/read_document` on the existing HostKernel RepoIntel
service. Source inspection shows out-of-body ServerAuth/RepoRead/Location binding, current
Guard `files.read`, no-follow regular-file access, UTF-8 and 6 MiB bounds, cancellation,
and exact pre/post workspace revision checks. P4's LSP client is being wired only to this
HostKernel reader; no app-process filesystem fallback is allowed. Parent documented the
additive operation in §12.18, §17, §30, §32 and §37 and added RD-017/LS-011 acceptance.
P1 is adding source coverage; this source path remains untested/unverified.

The trusted Core Config→HostKernel launch-profile decision is now defined by §12.20 and
`contracts-v2/execution-launch-profile-v1.schema.json`: immutable profile ID/revision/kind,
configured executable selector, literal argv, fixed registered-Location cwd policy and
sanitized host environment. No interpolation or P4-supplied executable/argv/cwd/env is
allowed. P1 is defining prepare/launch/read/write/cancel/status RPCs on existing
`execution.v1`; launch must revalidate exact profile, Guard intent/lease and scope before
spawn, bind the resolved executable digest to HostProcessRef/receipt, and treat ambiguity
as UNKNOWN/no relaunch. P4 has removed direct LSP filesystem read and PID/stop authority;
its process launches and DAP debuggee effects remain fail-closed pending the typed contract
and P1 Guard/confinement acceptance. REPL stays unavailable until required OS resource
limits are enforced. These changes are source/design only, not phase acceptance.

P2 owns Core/TUI and `managed_control.rs` managed state. P1 owns HostKernel/process ingress;
P2 will provide the durable verifier intent/evidence contract and P1 will integrate its
HostKernel dispatch once the generic process boundary is ready. Keep verifier finalization
and worker fan-out disabled. P3/P5/P6/P7/P8/P9 and final integrated verification/release
remain queued/partial. HorizonCode V1 remains PARTIAL / NOT RELEASED.

## Latest integration note — 2026-10-19 19:22 UTC

The user confirmed existing trusted Core Config as the launch-profile source projected to
HostKernel and routed through the existing single ExecutionHost supervisor. P1 has been
directed to require immutable verifier-profile revision with no migration/default; P4 uses
only the exact profile reference and remains fail-closed pending P1 Guarded dispatch.

Parent source inspection found a launch contract mismatch: the normative launch profile and
strict JSON schema use `executableSelector`, while the current Rust profile decoder requires
an absolute `executable` path. P1 owns changing the IPC decoder/resolution so HostKernel
resolves the trusted selector without accepting caller-supplied executable paths. The strict
machine schema also needs the actual `HostProcessRefV1` shape already present in Rust,
TypeScript and §12.9, including profile/executable pins and only the applicable process-kind
variants. No validation ran. P1/P2/P4 are the three active whole-phase owners; P3/P5/P6/P7/P8/P9
remain queued. Git remains broadly mixed on `main` 12 commits ahead; do not stage, commit,
push, clean or prune. C: `/mnt/c` has 60 GB free. V1 remains PARTIAL / NOT RELEASED.

### Integration continuation — 2026-10-19 19:26 UTC

P1 source now decodes `executableSelector` and resolves only a small per-kind HostKernel
allowlist through fixed system binary directories, canonicalizing and digesting the result.
This remains untested and does not establish Guard/confinement acceptance. The parent added
the strict eight-field `HostProcessRefV1` contract to
`arch_V1/contracts-v2/execution-launch-profile-v1.schema.json`, aligned with Rust/TypeScript
and excluding PID/path authority. P1 still owns live binding/lease/scope/receipt proof; P4
still owns the typed HostKernel operation/event adapter and full lifecycle. P1/P2/P4 are active;
P3/P5/P6/P7/P8/P9 await slots. The implementation-first hold remains in force: no verification
commands have run. Git state remains mixed and untouched; no staging, commit, push, cleanup or
prune. `/mnt/c` has 60 GB free and no HorizonCode build/test process is active.

### Integration continuation — 2026-10-19 19:30 UTC

P2 confirmed there was no explicit Core selector map: `TaskTool` chose by `profileId` or display
name and selected the highest enabled revision. Architecture now specifies Core-owned
`agent_profile_selectors: [{selector, profileId, revision}]` in global user-owned
`opencode.json`/`.jsonc` only (project config cannot override), with exact immutable targets,
no implicit display/legacy-name aliases, duplicate/conflict/stale/owner rejection, deliberate
remapping, and exact Session-pin resume. P2 owns implementation; VEO-017 was tightened. P1 source
has HostProcessRef and receipt pins, mandatory verifier profile revision, honest unsupported
resource guarantees, canonical language capability IDs, and direct Attempt admission through
P2's reservation API. P1 has drafted `execution.v1/protocol_op`/`protocol_read` with bounded
typed operations/events, replay cursor, scope/revision fencing, and UNKNOWN-on-ambiguous-receipt
semantics; Guard dispatch and complete launch selector resolution are still open. P4 removed raw
LSP stream/process handles and is narrowing the adapter; `didClose` and runtime wiring remain
open. P2 found HostKernel direct profile reservations had no terminal-release call. Source now
releases after durable SUCCEEDED/FAILED and CANCELLED; UNKNOWN remains reserved. Admission-
abandon and restart-replay paths still need reconciliation. The HostProcessRef schema's process
identity length is aligned to the 160-character Rust/TypeScript validators. No validation
commands ran.
The managed verifier source also disagrees with §3.22: the OwnerLog reducer expects a settled
Succeeded Attempt before verification, but the accepted V1 flow keeps the coding Attempt live
through independent verification and settles only after evidence. P2 owns the reducer repair;
P1's HostKernel path already resolves the live verification Attempt.
V1 remains PARTIAL / NOT RELEASED.

### Current continuation — 2026-10-19 19:34 UTC

The user confirmed that trusted existing Core Config is the launch-profile source projected
into HostKernel and dispatched by the existing single ExecutionHost supervisor. P1/P2/P4
remain the active whole-phase owners; P7 is next on a real slot release. Parent source review
sees finite-number validation in `LanguageProtocolOperationV1`, typed `textDocument/didClose`
in the LSP adapter, P2's explicit Core Config selector resolution and AgentProfileV2 projection
into HostKernel direct-Attempt admission, and a managed reducer branch that records the exact
live EXECUTING Attempt for verification. These are source observations only. HostKernel now
has typed `protocol_op`, `protocol_read`, and `protocol_reply` routes with process/scope/
workspace/challenge/lease validation, but returns `capability_unavailable` before IO until the
durable receipt journal and replay event buffer exist; no lease is consumed and LSP/DAP stay
unavailable pending the full lifecycle.

P1 has since source-wired startup reconciliation for durable direct-child capacity:
pre-admission empty reservations can be abandoned only before Core receives child authority;
otherwise the reservation tuple must exactly match the durable Attempt's parent/child
Session, principal, profile ID/revision/digest or HostKernel startup fails closed. EXECUTING and
UNKNOWN remain reserved; terminal slot-release recovery is idempotent. The protocol read-page
decoder also now rejects sequence gaps. P1 closed the code-mode MCP bypass in source: nested
`callTool` dispatch is removed/denied, the `execute` tool is not registered even under the
experimental flag, and a fake-client zero-dispatch regression was added (not run). P2 source
now preserves and resumes only the same active Attempt for a durable VERIFYING Run when the
verifier, receipt chain, current head, and absence of verifier intents/evidence match; it does
not renew the Attempt owner epoch. P1 still needs to revalidate the live lease epoch and
recover the exact challenge journal before verifier dispatch. No phase is accepted.

No tests/builds/typechecks/audits/provider probes/performance runs have been run under the
implementation-first hold. Git MCP: one worktree, `main` 12 ahead, broad mixed staged,
unstaged and untracked state, no conflicts. C: via `/mnt/c`: 60 GB free (87% used). Keep the
state unchanged; no staging, commit, push, cleanup or prune. V1 remains PARTIAL / NOT RELEASED.

### Managed verifier crash-window correction — 2026-10-19 19:43 UTC

Cross-phase source review found the middle verifier recovery branch is not implementable from
the current durable fields: P1's `reconcile_managed_verifier()` returns UNKNOWN for terminal
process rows because output bytes are not retained. Host-captured output and ArtifactStore
publication happen after execution, so current target receipts cannot reconstruct evidence
after a crash. P2 removed preservation of an EXECUTING Attempt with existing verifier intents.
Current reducer source now allows only (a) the exact live coding Attempt before any verifier
intent, with complete successful coding receipts at the frozen revision, or (b) SETTLING with
typed evidence and all matching criterion/profile/executable/epoch, revision, receipt and
artifact refs already durable. A possible-dispatch crash before typed evidence remains UNKNOWN
and is never replayed. P1 owns adding authenticated reconstructible output/artifact journaling
if that recovery case is to be supported. VEO-018/§37.22 record the requirement. This source
correction is untested; V1 remains PARTIAL / NOT RELEASED.

**HostKernel verifier integration remains open:** P1 source review found the current
`managed_begin_verification`/`managed_execute_verification` route does not call P2's durable
Attempt effect/intent/receipt reducer APIs. Its broker authorization currently uses an empty
Session and requires no Attempt scope. P1 owns the HostKernel path; P2 owns the reducer. The
route must bind authenticated Session/Location, the exact live Attempt and effect IDs, owner
epoch, current workspace revision, distinct reviewer approval, and one-use Guard lease, then
record exact terminal receipts/evidence through P2's APIs. Until this is wired, the reducer's
live-Attempt source path is not a production verifier, and dispatch/finalization stay disabled.

P2 confirmed the restart owner-epoch check belongs to HostKernel: the durable managed reducer
has no authenticated current-epoch input. On startup and before verifier begin/execute,
HostKernel must compare the persisted epoch to current authenticated owner state and live
durable lease/challenge state; stale Attempt state is durably UNKNOWN/RECONCILING (preserving
CANCELLING) and cannot renew or dispatch. §37.22/VEO-018 capture this. Parent added the strict
`ExecutionProtocolDispatchReceiptV1` schema; P4's request/event decoders and replay handling
are being aligned with it. These edits remain untested.

P4 source review found `test/lsp/client.test.ts` still starts a child process and expects the
removed raw MessageConnection; P4 owns replacing it with typed adapter contract fixtures and
adding DAP adapter fixtures (source only). The current DAP client maps `threads` to canonical
read-only `debug.stack`; parent confirmed Rust Guard must match this mapping. `variables`
stays denied because adapter passive-inspection semantics are not proven. Core validates the
authenticated HostKernel receipt against the pending process ref, sequence and operation; it
does not add a BLAKE3 dependency to recompute Rust's canonical digests. No tests were run.

### Current source continuation — 2026-10-19 19:51 UTC

The user confirmed the trusted launch-profile decision: existing Core Config is projected
into HostKernel and executed only by the existing ExecutionHost supervisor. This resolves the
launch-profile source question; it does not enable process effects.

P1's current HostKernel source calls the P2 managed reducer APIs for Attempt-bound verifier
effects, verifier intents, receipts and typed observations, and rejects stale owner epochs.
`TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false. Terminal verifier output and ArtifactRefs
still cannot be reconstructed after a possible-dispatch crash; that state stays UNKNOWN and
cannot be replayed. The `execution.v1` protocol handlers still reject before IO until the
durable operation journal and replay buffer land. P1 still owns universal Guard origin
closure, ToolBatch/lease/receipt recovery, safe process launch, confinement and adversarial
coverage.

P1 also added canonical operation/dispatch-receipt digest helpers and strict ACK parsing to
`kernel/src/protocol.rs`; this is contract code only, without durable sequence journaling,
supervisor writes, receipt-before-ACK or replay. P4 replaced the raw-child LSP fixture with a
typed no-effect fixture and added Core-side LSP/DAP protocol journals for monotonic outbound
sequences, receipt/process-IO sequence comparison, response correlation, exact replay
suppression and conflict quarantine. Real HostKernel protocol IO, process launches, DAP
debuggee effects and REPL remain unavailable pending P1 Guard/journal/confinement/resource
prerequisites. These source changes have not been run.

P2 added a revision-fenced Goal Run pause/resume/cancel HTTP route, SDK operation and TUI
`goal.control` confirmation path. The TUI reads the current Goal/Run snapshot, displays its
exact revision and sends it back; the handler rejects a stale view before CAS. These source
changes are untested. No tests, builds, typechecks, audits, probes or performance runs have
started under the implementation-first hold. P1/P2/P4 remain active whole-phase owners; P7
is next only when a real slot opens. Git state remains broadly mixed and ownership must be
preserved; no Git mutation or cleanup. C: `/mnt/c` most recently showed 60 GB free.

V1 remains PARTIAL / NOT RELEASED. P1–P9 implementation, integrated verification, real-work
acceptance and release gates remain open.

P1 integration review found a result-truth defect in `managed_execute_verification`: the
managed reducer sets `RunPhase::Failed` when any accepted criterion verdict is FAIL, but the
HostKernel handler currently returns `status: VERIFIED` after every settlement. P1 owns
deriving the response from the durable post-settlement Run state and adding a source
regression. The adapter remains disabled; this is not acceptance evidence.

P4 added DAP event-page Attempt/process/workspace scope validation, `maxEvents`/`maxBytes`
checks, IO-sequence pin advancement and skipped-cursor rejection in the Core-side protocol
journals. The REPL registry now retains its validated `directAttemptScope`; source-only DAP
fixtures cover these fences. HostKernel `protocol_op`/`protocol_read`/`protocol_reply` still
reject before IO pending P1's durable journal/replay implementation. No tests were run.

Open recovery finding: `settle_durable_verifier_evidence` currently accepts Run phases
VERIFYING/SUCCEEDED/FAILED but not CANCELLING, while the reducer intentionally preserves
CANCELLING through Attempt settlement. A crash after durable evidence/settlement during
cancellation could leave the challenge journal unreconciled. P1 owns evidence-only
CANCELLING reconciliation with no dispatch; P2 owns truthful CANCELLING response schema/TUI
projection. Source fix and validation remain pending.

### P1 verifier-settlement source update — 2026-10-19 19:53 UTC

HostKernel now source-wires the live Attempt happy path through durable typed evidence and
settlement: after `record_observed_verification`, it derives the sorted receipt digest from
the exact OwnerLog effect receipts, issues `BeginAttemptSettlement` and `SettleAttempt`, and
marks the verifier challenge set SETTLED only after the managed reducer commits. Workspace
drift records terminal verifier receipts before fencing the Attempt UNKNOWN. This remains
source-only behind the false verifier-adapter gate. P1 must reconcile a crash after OwnerLog
settlement but before the verifier journal's SETTLED update from durable OwnerLog state only;
no recovery may redispatch. A crash after process completion but before durable typed evidence
or artifact references remains UNKNOWN/no-replay.

P2's Goal Run TUI control now obtains the authenticated Goal snapshot, resolves the selected
Run, displays its phase/revision in a confirmation dialog, submits `expectedRevision`, and
receives a bounded Run status projection. The HTTP handler rejects stale views before OwnerLog
CAS; source regression fixtures were added but not run. P1/P2/P4 remain active whole-phase
owners, all phase/release acceptance remains open, and implementation-first hold continues.

Latest P1 source correction: evidence-only recovery now includes RunPhase::CANCELLING and
CANCELLED, validates the exact settled receipt digest, and returns truthful status for failed,
cancelling, cancelled, verifying and succeeded outcomes. Old owner epochs are tolerated only
for evidence-backed SETTLING/SUCCEEDED reconciliation without dispatch; stale unresolved
EXECUTING/ADMITTED work is marked UNKNOWN. P1 also added strict ACK/digest helper validation
and DAP requestID safe-integer bounds. P2 still owns aligning the TypeScript verifier status
schema/SDK/TUI for CANCELLING and CANCELLED. These are source changes, not verified behavior.

Latest P4 source correction: LSP/DAP journals now return stored receipts for exact duplicate
ACKs, quarantine same-sequence payload/receipt conflicts, bound local receipt history, and
validate inbound cursors and integer event/byte bounds even when the caller bypasses the event
cursor. No HostKernel dispatcher/read journal exists yet; actual protocol IO remains disabled.

P2 has since aligned the GoalVerification response schema and SDK types for CANCELLING,
CANCELLED and FAILED, and added matching TUI status messages. The source contract now aligns
with P1's HostKernel mapping; fixtures remain unrun.

### 2026-10-19 20:01 UTC — managed prompt boundary and current phase queue

P2 identified the missing production entry from managed admission into Core prompting: managed
control can plan/admit, while prompt execution accepts only direct Attempt authority. To prevent
a shared-file race, P2 owns `packages/opencode/src/session/prompt.ts`,
`packages/opencode/src/session/managed-control.ts`, and its managed route/UI caller for typed
ManagedAttemptScope propagation. P1 exclusively owns `packages/opencode/src/session/tool-batch.ts`,
the Guard client and HostKernel validation/receipt binding; P2 supplies the exact scope contract
for P1's ToolBatch seam. The envelope carries Goal/Run/Task/Attempt, owner epoch, expected
managed revision, Location/Session, workspace revision and delegation-binding digest. HostKernel
must validate all pins against durable authenticated state; they do not grant authority. No
effectful dispatch is enabled by the caller plumbing alone.

P1/P2/P4 occupy the three available child slots; P7 is next on actual slot release; P3/P5/P6/P8/P9
are queued. The no-validation hold remains active until all requested V1 source implementation
closes. At 20:01 UTC C: via `/mnt/c` had 60 GB free and `node_modules` used 2.5 GB. Git remains a
mixed tree on `main`, 12 ahead of `origin/main`, with no conflicts. Preserve all state; no
staging, commit, push, cleanup or prune was performed. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 20:03 UTC — Attempt scope revision and batch lease ordering

P1/P2 identified that an Attempt scope digest includes `expectedManagedRevision`, while atomic
batch-to-Attempt binding advances that revision. Normative resolution: pre-bind scope remains
challenge-evaluation provenance only. After full Guard evaluation and any required explicit
approval, HostKernel binds the exact batch edge set atomically, returns a refreshed scope,
rechecks the live authenticated Attempt, edges, revision, workspace, policy and approval, then
issues a lease bound to the post-bind scope plus its exact edge/intent. ALLOW also defers its
lease; challenge binding may transition once before a lease exists. No issued lease is mutated
and no caller-supplied revision/rebase is authority. This applies to managed and direct child
effects; P1 owns EffectHost/HostKernel sequencing, P2 the managed scope contract. VEO-019 records
the required race/replay/recovery acceptance.

P2 has source-added typed managed authority/scope propagation through managed-control, prompt
and LLM, plus a bounded atomic managed batch-edge reducer command. P1 owns ToolBatch and effect
forwarding. Source-only; caller plumbing remains fail-closed until HostKernel consumes this
contract. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.

P2 confirmed HostKernel `managed_admit` remains unavailable: trusted DelegationBinding and
owner proofs are not yet assembled despite profile/context shape validation. P1 has accepted
whole HostKernel admission ownership and will bind the exact Task profile and return the trusted
managed Attempt scope; P2 owns the authenticated Core/TUI trigger and strict response adapter.
The managed path remains disabled pending P1 admission, Guard/lease sequencing and recovery. P2
must refresh the scope after every managed OwnerLog change before another effect. This is a
source ownership update only; no validation ran.

P1's deeper source audit found managed admission also requires authenticated Attempt/profile/
context proofs, active parent WorkerExecution proof, a durable P8 worker lease, and a Guard-minted
effective capability ceiling. The current HostKernel has no producer for parent execution/worker
lease facts; `open_worker_owner` keeps fan-out closed and no WorkerPool RPC supplies them. P1
will not invent proof from caller fields. P8 is therefore a critical dependency for P1 admission
and P2's managed vertical; P7 artifact storage remains another P2 verifier dependency. Queue
both full-phase owners for actual slot releases.

P4 reports a method-bounded DAP adapter and hardened LSP transport source (Guard command
classification, sequence/ACK/replay/generation fences, serialized writes and frozen Attempt
scope). All effectful launches remain unavailable pending P1 protocol IO/launch/confinement;
REPL also needs OS-enforced quotas. Source-only, no validation. V1 remains PARTIAL / NOT RELEASED.

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


## 2026-10-19 20:40 UTC — active execution handoff

User decision: add explicit authenticated goal.start after an accepted SpecVersion. goal.plan stays PLAN_ONLY; acceptance alone does not start work. Rust atomically/idempotently transitions the exact current accepted SpecVersion's complete persisted PLANNED Run/task set to RUNNING/ready. It grants no effect authority. P2 owns the complete Core/API/SDK/TUI/Rust path. Architecture and acceptance updated in §§3.4, 17.18, 32.38/VEO-023, 37.22.

Active owners: P1 p1_guard_v1_resume_1020; P2 p2_managed_v1_resume_1020; P7 p7_stream_artifacts_v1_1020. All three child slots are occupied. P1/P2 coordinate observation_digest receipt contract; do not edit P2-owned managed_control.rs from P1. P2 durably persists crash recovery UNKNOWN with stable idempotency. P7 implements a digest-bound targeted per-path checkpoint recovery preview after later commits; restore remains disabled and destructive full reset remains refused.

Queued whole phases: P8 (prior owner exited; direct P1/P2 dependency), P4 (returned partial; dependent on P1 launch/IO/confinement), P3/P5/P6/P9. Reassign immediately when capacity opens, following critical path.

Hold and resources: user requires implementation source closure before tests/builds/typechecks/audits/probes/performance runs. No such validation ran. Git remains mixed (150 staged plus many unstaged/untracked files; no conflicts), branch main 12 ahead; do not stage/commit/push ambiguous work. One worktree; no pruning. C: via /mnt/c: 60 GB free, 87% used. No Cargo/Bun/test process active. V1 PARTIAL / NOT RELEASED.



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


### Active source review — Goal start and automation adapter

The accepted V1 decision is a separate authenticated `goal.start` after a persisted, complete,
profile-pinned PLANNED Run. P2 reports the TUI caller is in source; it does not grant Attempt or
effect authority. Parent review corrected P2 automation projection/status mismatches, and Core
`runNow` now returns typed CAPABILITY_UNAVAILABLE before any HostKernel RPC. P1 must preserve an
independent Rust-side refusal before scheduling or Guard dispatch. P1 continues serial ToolBatch
lease, Guard, managed admission and checkpoint routes while coordinating P7's bounded Rust
registry API. P1, P2 and P8 remain active whole-phase owners. No validation was run; current
source and all V1 acceptance remain unverified.


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


### Latest source-only status — 2026-10-19 21:17 UTC

The candidate-renewal chain is now explicit in normative owners: P8 returns an opaque durable
EXPIRED tombstone receipt with its own OwnerLog cursor/event digest, exact worker/ticket/Attempt,
pins digest, pool revision and proof/receipt digests; P2 persists the READY Task's generation
advance idempotently; P1 derives the next candidate only from persisted Task ID/generation.
P8 is adding Attempt uniqueness. The old candidate is never reused and this transition grants no
dispatch authority. Parent review found P1 has since made `UnixPeerIdentity` listener-only with
private fields and live PID/start/executable revalidation; explicit handshake/fence incarnation
documentation is being added. P1 also fixed a source-level partial-prefix cancellation check;
remaining phase work continues. **No tests, builds, typechecks, audits, provider probes or
benchmarks have run.** Three actual child slots are occupied by P1, P2 and P8. V1 remains PARTIAL /
NOT RELEASED. Current local Git counts are mixed and ownership-ambiguous; preserve them. C: via
`/mnt/c` last showed 59 GB free; there is one main worktree.
Candidate identity binds Task ID plus both durable Task counters: admission increments
`attempt_count`, and a verified pre-admission tombstone increments `candidate_generation`. P2's
proof/event/receipt CASes both values; P1 includes both in immutable admission pins and derives
the candidate from all three values. This prevents collision after a terminal admitted Attempt
is retried.
P2 now represents candidate tombstone disposition and terminal state with typed enums and
strict persisted-event decoding. P8 removed an invalid comparison between a worktree base
revision locator and measured workspace content revision; both remain distinct pinned facts and
are covered by §§21.11/37.22. No validation ran.
Candidate IDs bind both durable Task counters: admission increments `attempt_count`, while a
verified pre-admission tombstone increments `candidate_generation`. P2 now includes the expected
attempt count in its proof/event/receipt CAS; P1 includes both counters in immutable admission
pins and derives the ID from Task ID plus both counters. This closes collision after an admitted
Attempt is retried. P8 receipt identity/digests remain as above.


### 2026-10-19 — current whole-phase continuation

The latest user continuation note reiterates source-first comparison with local OpenCode/Codex, full subagent lifecycle review, full V1 delivery, implementation before validation, and updating all relevant Markdown. No new architecture decision is needed; existing §17 decisions remain authoritative.

P1/P2/P8 are active whole-phase owners. Candidate renewal is source-present: P8 recovers a durable `NotAdmittedNoDispatch` + `EXPIRED` tombstone receipt by candidate Attempt ID; P1's authenticated HostKernel route derives the ID from the live READY Task's `attempt_count` and `candidate_generation`, validates accepted SpecVersion/profile/SessionLink, registered Location/workspace, authenticated Core peer and ServerAuth, and no process binding, then passes the opaque receipt directly to P2. P2 independently recomputes identity and revision-fences the two-counter generation transition with exact delivery replay. Worktree base revision remains a locator distinct from measured workspace content revision.

This is source-reviewed only; no validation command ran. P1 managed admission/claim/consume and P2's production TaskTool dispatch remain dependent on P8 reservation/binding proof and P2 consume integration. P3/P4/P5/P6/P7/P9 and final integration/release remain open. V1 is PARTIAL / NOT RELEASED. Git remains mixed (150 staged / 238 unstaged / 173 untracked; no conflicts), one main worktree; C: via `/mnt/c` has 59 GB free. Preserve all work; no safe publication boundary is established.


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


### Resume checkpoint — root Session attachment on explicit goal.start

The root Run Session cannot be selected after start or attached in a post-start gap. `goal.start`
will take the active top-level Core Session ID; Core verifies the durable Session's authenticated
principal, project, workspace and Goal relationship. Rust atomically pins the Run SessionLink
with the explicit start event and fences changed retries. HostKernel registers the authenticated
P8 root coordinator before admission/scheduling; failure keeps execution unavailable. Start
still creates no Attempt/effect lease. P1 owns HostKernel/authenticated peer handling, P2 owns
managed reducer/API/Core/TUI, P8 owns durable root registration. Design is settled; source
integration is ongoing. No tests/builds/typechecks/audits/provider probes/benchmarks. V1 remains
PARTIAL / NOT RELEASED.

Resource sampling correction: P8's sampler is Attempt-scoped telemetry/backpressure, not admission
authority. ActiveWorkers uses durable Rust accounting bounded by pool/Spec. Do not sample before
admission or turn unknown optional telemetry into a denial. No public resource wire op before the
§12.16 schema; diagnostics stays unavailable.

P8 source checkpoint: intent-only worktree operations may recover for dispatch; a durable
`worktree_dispatch_started` marker recovers as UNKNOWN with no redispatch. Safe release requires
same-root clean pre-delete evidence plus post-delete MISSING and no dirty/user-owned changes.
Legacy receipts without pre-release evidence are history only. Remaining P8 work is still active;
no validation has run.

P1 confirmed the sampler cannot see sibling Run workers before an Attempt exists. Metrics remain
informational/backpressure only; unsupported required OS-enforced limits remain unavailable. No
sampling route is wired until an existing typed consumer/schema is present.

Worktree admission provenance gap: P8 found that raw public registration facts could create
eligible records without a Guarded Create receipt. P8 is replacing this with an opaque value
derived from the exact settled Guarded Create intent/receipt and HostKernel-resolved canonical
path/base locator; P1 wires its guarded route. New admission requires fresh no-follow clean,
owned, current evidence. Legacy registrations do not qualify. Implementation only.

Update: P8's opaque `VerifiedWorktreeRegistrationV1` now binds exact durable completed Create and
fresh Inspect receipts, owner, root generation, worktree/base/content revisions and canonical
path. Both receipts are rechecked; registration requires owned no-follow CLEAN state, zero dirty
entries and no user changes. Legacy registration events cannot qualify. P1 still must wire the
HostKernel lifecycle route; no validation run.

SessionLink source dependency: HostKernel authenticates Core process identity but has no Core
SessionStore/projector. It must not synthesize cursor or source metadata from the selected
`sessionID`. P2 supplies a private projection from the durable Core Session owner with principal,
Goal, project and workspace binding; HostKernel stamps its live owner epoch. Until that exists,
start stays unavailable and post-start SessionLink attachment is not an escape hatch.

Cursor digest: Core `EventV2.latestCursor` produces SHA-256, but Rust SessionLink requires the
actual BLAKE3 cursor from the existing `hc_session_receipts` projection. Never rehash the SHA-256
value to mimic BLAKE3. P2 must obtain the exact existing Rust SessionSupervisor cursor; otherwise
start remains unavailable.

P8 found that a safely deleted worktree could remain marked Free and be selected again. It is
adding a durable registration tombstone gated by clean pre-delete and MISSING post-delete proof;
the ID remains historical/non-reusable. P1 admission must select only current verified
registrations and fail closed on ambiguous removal/replay.

P1 found no HostKernel Guarded worktree Create/Inspect/Release route/journal/driver yet. Core
direct create/remove remains disabled. P1 owns the guarded HostKernel route and no-follow receipt
path; P8 owns durable registration/provenance/tombstone. Managed worktree admission remains
unavailable until both owner paths are wired.

P2 source update: Session creation now stores authenticated ServerAuth ownership in protected
internal metadata, and goal.start rejects a root Session whose owner differs from current auth.
HTTP metadata updates cannot alter owner/root markers. The goal.start response/SDK echoes
sessionID. Core store/instance/epoch guesses are not accepted as SessionLink facts; the actual
Rust SessionSupervisor BLAKE3 cursor/source projection remains required. No checks run.

Pre-Task worktree lifecycle/registration uses P8 `WorktreeRootOwnerV1` derived from authenticated
root coordinator proof for an already-started Run. It conveys root Session/workspace/Location/
principal/epoch lineage only. P1 still evaluates Guard; P8 attaches one verified registration to
one exact Attempt at admission to prevent writable sharing. Never fabricate Task/Attempt IDs or
treat the root proof as child/effect authority.


### Source correction — SessionLink and goal.start

`SessionSupervisor.sessionProjectionCursor(sessionID)` already returns the durable Rust projection
ACK checkpoint and exact BLAKE3 cursor; cursor acquisition is implemented. Remaining identity
fields are being wired from durable Core ownership: immutable database sourceStoreID, immutable
project-directory sourceInstanceID, and per-Session sourceEpoch (starts at 1 and changes only on
explicit lineage reset/replacement, not process restart). No path/time/process-epoch synthesis is
allowed. User confirmed explicit authenticated `goal.start` after accepted SpecVersion; it
atomically pins SessionLink and grants no Attempt/effect authority. P2 owns Core identities/start
projection, P1 owns HostKernel validation/pinning. P1's managed worktree lifecycle API is a private
authenticated control request routed through existing Guard/EffectIntent/lease/receipt/confined
ExecutionHost using catalog `git.worktree.acquire/list/release`; model ToolBatch and caller paths/
argv cannot select pool operations. Source only; no checks run.

P8 has specified the opaque `WorktreeLifecycleOperationPinV1` for P1: only P8 getters expose the
persisted operation ID/kind, root owner/ref, selected worktree ID, optional base locator, relative
path, expected workspace revision, intent cursor and epoch. Create targets a fixed path beneath
`.horizon/worktrees/<id>`; inspect/release targets are resolved from P8 registration/lease state.
The pin is not authority to execute. P1 must Guard and issue EffectIntent/one-use lease/receipt via
the confined ExecutionHost; P8 persists possible-dispatch before execution. Release requires clean
pre-delete + MISSING post-delete + no active lease and permanently tombstones the registration.
Possible-dispatch restart recovers UNKNOWN without redispatch. No checks run.

Core SessionLink `sourceDigest` is domain-separated SHA-256
(`horizoncode.session-link.source.v1\0`) over the ordered bounded projection fields specified in
§12.3, with each UTF-8 field prefixed by u64 big-endian length; null latest message/part refs encode
as empty fields, and transcript content is excluded. No checks run.

### Latest resume checkpoint — 2026-10-19 22:06 UTC

User confirmed explicit authenticated `goal.start` after accepted SpecVersion and complete persisted PLANNED Run. P1 has source for typed HostKernel SessionLink validation, authenticated Core-peer checks, epoch stamping and atomic start. P2 is adding authenticated P8 root registration after start; admission/scheduling must remain blocked until registration succeeds. Start grants no Attempt/effect authority.

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P8 resources/workers/worktrees/RC0. P1 is implementing one global user-owned Core Config `git_executable` absolute path and private authenticated projection to the existing supervisor; HostKernel canonicalizes and hashes it, pins revision/digest, and rechecks before launch. Project/plugin config, ambient PATH and caller/model executable/path/argv are excluded. P8 has read-only pending-intent lookup, a possible-dispatch marker ordered after Guard/approval/one-use lease, replayable removal receipts and new regression fixture source. P2's production Rust-selected scheduler→TaskTool prompt path remains absent. P3/P4/P5/P6/P7/P9 and integrated acceptance/release are open. Implementation-first hold remains: no tests/builds/typechecks/audits/provider probes yet. Preserve mixed Git state; no stage/commit/push. One primary worktree; C: has 59 GB via `/mnt/c`. V1 remains PARTIAL / NOT RELEASED.

### Design correction — 2026-10-19 22:09 UTC

`goal.start` must not depend on optional Git configuration. Parent directed P2 to complete the explicit start and authenticated root-coordinator registration first, then register Git profile only on the managed worktree acquire path before dispatch. Missing Git profile continues to deny worktree effects and admission; it does not invalidate the effect-free start.

P1 must preserve `.git` read-only and, only if the OS backend can enforce it, permit a broker-only write exception for `.git/worktrees`; use fixed trusted argv and `--no-checkout`, and fail closed if nested enforcement is unsupported. P8 is adding a Create-receipt-derived Inspect target so first-time Create→Inspect→Register is possible without caller paths/IDs. No validation commands run.

P2 has corrected start ordering: Git-profile registration no longer runs during `goal.start`. Start pins SessionLink and registers the P8 root coordinator; a separate adapter registers the global user-configured Git executable before managed worktree acquire. P8 added a Create-pin/receipt-derived Inspect target with current root proof and clean/owned/no-follow evidence, while Release targets remain restricted to verified registrations. Parent also flagged Git worktree roots represented by `.git` gitfiles: the common Git directory must be resolved by trusted no-follow HostKernel inspection and independently confined, or worktree operations for that Location stay unavailable. Source only; no verification.

Pending worktree operation recovery ruling (22:12 UTC): intent-only Pending plus absence of the pre-invocation dispatch marker proves NotAdmittedNoDispatch. P8 will durably retire an exact old operation with an EXPIRED receipt only under fresh same-Goal/Run/root-Session/Location/workspace lineage proof. This receipt grants no execution and cannot mutate the tree. Replaying the old key returns the receipt; any later operation uses a new key and reruns Guard/approval. Epoch/root mismatch or ambiguity remains denied.

P2 has tightened root registration and retry checks: it compares the exact root execution identity, OwnerLog cursor/digest and pool revision, and its protected local root binding includes the accepted SpecVersion and SessionLink digest. Source only; unverified.

P2 follow-up: `goal.start` retry currently recomputes a moving Core cursor. Rust already projects the pinned Run SessionLink, but TypeScript `decodeGoalReviewSnapshot` drops it. Decode/use the exact pinned link for already-started Run recovery; compute fresh only before first PLANNED→RUNNING transition. This is required for a crash after Rust append but before Core root-binding metadata and for changed transcript cursor retries.

First-create sandbox path: P1 will, only after Guard/approval/lease and the durable P8 possible-dispatch marker, create exact missing `.git/worktrees` and `.horizon/worktrees` roots with descriptor-relative no-follow/no-clobber checks, then prepare the existing sandbox and launch fixed Git argv. Definite spawn absence needs an exact supervisor receipt; ambiguous mkdir/preflight/spawn is UNKNOWN and never auto-retried. Failure to enforce nested roots keeps the route unavailable.

P8 completed source for the pending no-dispatch tombstone and replayable EXPIRED receipt with same-lineage proof and same-key idempotency. It cannot mutate worktree state or revive the old operation. A source fixture was added but not run; P8 continues the whole phase across reservation/process receipts, owner-epoch fences and sampler recovery.

### 2026-10-19 22:15 UTC — resume source checkpoint

After context recovery, the parent re-read the controlling AGENTS/current-run/handoff/architecture/governance/operative-plan sources and Engram context. User-confirmed managed start contract remains: accepted SpecVersion → persisted PLANNED Run → authenticated `goal.start`; Rust pins the exact root SessionLink and grants no Attempt/effect authority. P2 now decodes the Rust-pinned link and reuses it on RUNNING replay; its snapshot-before-read temporal-dead-zone was corrected in source. P1 preserves that pinned owner epoch during replay and requires fresh authenticated root registration before scheduling resumes.

P8 added owner-epoch validation when replaying no-dispatch worktree retirement. Remaining whole-phase source work includes P8 reservation/process receipt and resource attribution/recovery; P1 HostKernel guarded worktree lifecycle routing and final pre-dispatch/OS-confinement paths; P2 production selected-Task→TaskTool prompt execution and independent reviewer/verifier/current-workspace evidence/control recovery. P3/P4/P5/P6/P7/P9 remain to be assigned as child slots free. No validation commands run. Preserve mixed Git state; never stage/commit/push ambiguous work. Disk check used `/mnt/c` (59 GB free); one primary worktree, no task-created worktrees to prune.

P8 additionally changed worker-resource sampling to consume fresh authenticated Core peer facts at sample time and derive the process identity there; a stale same-epoch identity token can no longer be reused. This is telemetry/backpressure, not admission authority or proof of OS resource quotas. No production route exists yet; P1 must supply fresh peer facts for each eventual call if an approved route is wired.

### Settlement/reconciliation seam (2026-10-19 22:19 UTC)

I ruled that P8 must not expose durable `SettleWorker` / `ReconcileRelease` producers accepting bare `WorkerSettlement` or `ReconciliationProof` booleans. The selected internal contract is in arch_V1 §17.24: opaque P1 HostKernel-minted proof binds exact P8 state/cursor/revision, managed Attempt/DelegationBinding, claim nonce, process generation/epoch and P2 terminal/effect evidence; P8 rechecks and appends; exact replay resolves a stable receipt. UNKNOWN, stale or ambiguous proofs retain quarantine/capacity. P8 is implementing the durable side and P1 the authenticated minting side; no tests/builds run.

Logical-worker settlement correction (2026-10-19 22:19 UTC): the V1 managed child is a Core child Session/Attempt in the existing Core process (§17.20), so it has no worker-specific PID to observe exiting. P1/P8 agreed not to assert `ownedProcessExited=true`. The revised §17.24 proof requires authenticated current Core/root owner identity, exact P8 cursor/revision/claim/Attempt binding, P2 terminal state and complete bound effect receipts, and P1 proof of quiescent prompt/callback scope, no active Attempt Guard leases and no owned command processes. Guarded workspace state governs reuse; UNKNOWN remains quarantined. Future process-backed workers have a separate exit contract. The plan records the superseding ruling and cost if wrong.

P1 source update (2026-10-19 22:19 UTC): exact HostKernel `goal.start` replay preserves the pinned SessionLink owner epoch; fresh start stamps current. Managed admission bounds expiry by profile, accepted Spec, persisted Run remainder and 24 hours. `register_git_profile` checks both ServerAuth and the authenticated Core peer; supervisor rehashes the configured Git binary immediately before spawn; EffectHost's broker path allows only the three Git worktree IDs as UserAction and verifier remains ManagedRun-only. P1 §14.20 records constrained first-create metadata-directory rules. Still no guarded worktree HostKernel route/driver or P1↔P8 settlement producer, and P2 still lacks the production Rust-selected TaskTool caller.

Settlement evidence is being aligned: P2 is adding a crate-private canonical Rust terminal-Attempt/effect-chain projection for P1; P1 independently checks authenticated Core identity, prompt/callback quiescence, no Attempt leases or owned command process, then mints P8 proof. V1 WorkerExecution is a logical child Session in shared Core, with no child PID/exit. No tests/builds run.

2026-10-19 22:20 UTC — Added the durable quiescence event contract to §17.24. A logical managed child has no own PID, so after `promptManaged` returns Core records the terminal outcome and calls private authenticated HostKernel completion. HostKernel checks the live Core peer, exact consumed handoff/child Session/Attempt, no Attempt callback/Guard lease/owned command, mints a one-use proof, and ManagedControl appends `managed_dispatch_quiesced` with exact cursor/digest. Retry can recover only the same marker; it cannot invoke the prompt again. Crash/ambiguous provider dispatch without the marker remains UNKNOWN and holds P8 capacity. P1/P2 are implementing; no tests/builds run.


### 2026-10-19 22:24 UTC — active proof interfaces and remaining phases

P1 added host-owned quiescence source bound to the P2 terminal projection: it checks the exact child identity/effect chain, rejects active Guard challenges or terminals, requires same-child process receipts to be Exited and valid, and fences authenticated Core identity before/after observation. P2's typed terminal snapshot now exposes durable prompt-quiescence receipt cursor plus distinct admission and observed workspace revisions; its durable coordinator/prompt path remains in progress. P8 still needs the opaque logical-child settlement consumer and receipt replay; it is replacing boolean `ownedProcessExited` settlement. Parent caught a Task-revision/workspace-digest cross-domain equality check and asked P8 to validate those pins separately. No validation has run.

Parent implemented the P5 source correction in `packages/opencode/src/tool/websearch-broker.ts`: 408/425 now enter the single bounded transient retry pass; 401/403/407 fall through to remaining explicitly enabled routes; 429 records cooldown/falls through without retry; other non-auth client errors stop. P5 production tool dispatch remains unavailable until P1 Guarded outbound transport and P6 SecretBroker/auth composition are connected. P3/P4/P5/P6/P7/P9 and cross-phase/release acceptance remain open. Preserve mixed Git state; no stage/commit/push. C: 59 GB free via `/mnt/c`; one primary worktree.


### 2026-10-19 22:30 UTC — P5 no-key provider chain expansion and source correction

Parent continued independent P5 work while whole-phase P1/P2/P8 owners remain active. Research against current provider primary pages found anonymous/no-key search support for Exa MCP, You.com `profile=free` (100 queries/day), Tavily MCP's explicit keyless search mode, Firecrawl Keyless (per-IP daily cap), and Parallel Search MCP (anonymous lower-rate mode). TinyFish Search is free but its documented API path requires account/API-key or OAuth, so it is not classified as part of the anonymous no-key default. Updated §37.5 and §16.7 accordingly and added source links/recheck caveat to §42.

Source-only P5 changes: Core config now recognizes `tavily_keyless` and `parallel_keyless`; the cascade's enabled default/order and route cap now include the five anonymous no-key routes; adapters expose those fixed endpoints/tools (including Tavily's fixed keyless headers); the TUI settings list represents both routes and keeps network dispatch unavailable pending Guard. The route parser now accepts common provider snippet fields, and tool-display labels cover both additions. Parent also fixed transient 408/425 classification earlier. P5 remains partial: no production Guarded transport/SecretBroker composition, native grounded-model route, broader BYO adapters/credential controls, route-event/provenance integration, or acceptance evidence is complete. Search remains fail-closed. No tests/builds/typechecks/audits/provider probes/performance runs were executed; Crawl4AI's browser binary was unavailable and Context7 quota was exhausted, so official primary-page web search/open was used as a fallback.

### 2026-10-20 04:40 UTC — owner restart and implementation queue

P1, P2 and P8 whole-phase owners have restarted in the three available child slots, each with exclusive source ownership. Early source findings: P2's main missing vertical is the managed scheduler → TaskTool → distinct Core child Session/prompt caller; P1 still lacks HostKernel wiring for the existing typed launch profile into its single confined supervisor; P8 is checking existing durable settlement/worktree code against the updated §17.24 proof contract. Explicit authenticated `goal.start` remains after accepted SpecVersion and grants no Attempt/effect authority. Child profile authority is Core Config's versioned `AgentProfileV2`, with lane-tagged delivery and effective-scope digest.

Next queued whole phases: P4/P5/P6/P7/P3/P9 as slots free, with dependent effects held behind P1 Guard and P2/P8 acceptance. P5 must address the legacy Core direct HttpClient search origin as well as finish the approved cascade, but remain unavailable until Guarded transport/SecretBroker composition is real. Source-first user hold remains in force. No validation commands run. Preserve mixed Git state; no stage/commit/push; no worktree pruning. C: 59 GB free via `/mnt/c`. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 04:41 UTC — Task purpose and child lifecycle references

P2 identified a missing immutable Task title/purpose in Rust's scheduler projection. The parent decided to carry bounded title/purpose from the accepted Task/plan revision through HostKernel to Core; descriptive text grants no authority. P2 owns ManagedControl/Core Task projection and architecture updates; P1 owns HostKernel projection fields. P2 also found the Core child completion projection is not implemented; completion stays fail-closed until exact cursor plus BLAKE3 state digest are derived from durable Session receipts and agree with HostKernel.

Reference review used the actual Codex clone `repos/codex/codex-rs/core/src/agent/control` and multi-agent handlers, pinned OpenCode child `session`/`subagent-job`/restart flow, and OMP bounded executor/workpool. Adapt lifecycle and backpressure patterns only; direct Codex/OpenCode restart semantics cannot override Horizon's possible-dispatch/UNKNOWN no-replay contract. P8 reports durable settlement/worktree internals exist but still requires a full contract-to-source audit; P1 HostKernel ingress and P2 verified Task journey remain integration dependencies. No tests run.

### 2026-10-20 04:42 UTC — P8 source audit result; P5 dispatched

P8 source-complete audit (not phase acceptance): durable worker reservation, opaque logical-child settlement/reconciliation, worktree lifecycle/recovery, sampler attribution, UNKNOWN quarantine, and provisional-only RC0 reporting are present with no P8-owned source patch identified. Remaining P8 gates depend on P1 HostKernel worktree/sampler ingress and final Inspect receipt, P2 production Task child Session and verified terminal evidence, then authenticated RC0 measurements. P8 returns to the queue for those interfaces; source is NOT VERIFIED. Its slot is assigned to a whole-phase P5 implementation owner, including the legacy Core direct-search bypass. P1/P2/P5 are now active. No tests/builds/typechecks/audits/probes run.

### 2026-10-20 04:44 UTC — prompt quiescence versus Attempt terminal; Guard origin

Normative §12.19 requires the coding Attempt to stay EXECUTING until independent verifier evidence is durable. Therefore `managed_dispatch_quiesced` records only that the coding prompt/callback returned; it must be accepted while Task=PENDING_VERIFICATION, without using the terminal SETTLING snapshot. A distinct later terminal projection requires verified evidence bound to the current workspace revision before P8 settlement. UNKNOWN dispatch is never retried.

Managed worktree operations are root-coordinator lifecycle, not a user-invoked model tool and not a fake managed Attempt. P1 is implementing a private root-scoped Guard origin tied to authenticated Goal/Run/root Session/principal/Location/workspace and the exact P8 operation/cursor/epoch; it must pass existing Guard approval, one-use lease and receipt handling. If the current approval path cannot represent it safely, keep lifecycle unavailable. No tests run.

### 2026-10-20 04:45 UTC — Git provenance note

Git MCP observed a new HEAD commit `14830654c8e6f68b6450707b17b17b29d59fc649` after prior snapshot `6c8c5ab9ad127853e45abadd8a88aed79b7a710f`; branch now reports 13 commits ahead of `origin/main`. Its stat lists 469 paths. The parent agent did not create or push it, and has not altered index/history. Preserve current staged/unstaged/untracked work; no amend/reset/push until ownership and final verification are clear.

### 2026-10-20 04:50 UTC — route identity and registry ownership

Use the configured route key as `provider_id` and `web.search.<provider-key>` as fixed `route_id`; this distinguishes keyless from BYO variants and was confirmed against the canonical Core Config route list. P5 owns only the search-inspect import/registration delta in `packages/opencode/src/tool/registry.ts`; P2 must not edit that file. Search remains disabled until P1 Guarded transport/lease/receipt and P6 SecretBroker are complete. Parent has not run tests/builds/typechecks/audits/provider probes; user asked source implementation first. Current owners: P1 Guard/ExecutionHost, P2 managed vertical, P5 web search. P8 is source-complete but not accepted; resume it when a child slot opens for integration against P1/P2. C: 57 GB free via `/mnt/c`; one primary worktree, no cleanup. Preserve mixed unstaged source and the observed 13-ahead history; do not stage/push ambiguous changes.

2026-10-20 04:54 UTC — Permission digest contract correction: §§12.11, 29.2 and 29.20 assign the effective Core profile/parent-intersection permission digest to `SubagentDeliveryV1.direct_session`. The managed lane binds Rust `DelegationBindingV1` digest + Goal/Run/Task/Attempt; HostKernel’s current `permissionScopeDigest` is the profile ceiling, not the Core effective Session rule digest. P1/P2 were asked to keep these distinct and prevent managed TaskTool from comparing unlike digests. No managed prompt may become runnable until this seam is aligned. Source-only; no tests/builds.

2026-10-20 05:00 UTC — P5 integration gap: `fixed_web_search_route` currently covers only BYO POST routes and omits the five canonical built-in keyless MCP routes and Brave GET, while §37.5 makes keyless MCP the default chain. P1/P5 were sent the exact route coverage task: establish fixed endpoint/protocol/request/response bounds, connect only through Guarded Rust HTTP if supported, otherwise explicitly surface unavailable state. No provider probing, tests, or builds.

2026-10-20 05:04 UTC — P5 additionally owns the exported-but-unregistered `packages/opencode/src/tool/mcp-websearch.ts` direct HttpClient search origin; remove direct effect and keep parsers only, with P1 Guard-origin audit. The new P5 `websearch-inspect.ts` was hidden under root ignore-all; parent added exact ignore exceptions for source and its future test. Git MCP confirms the source is now visible as untracked. Do not stage it yet; final overlay audit remains pending.

2026-10-20 05:10 UTC — Stable managed child identity: Core derives `ses_managed_${candidateAttemptID}` from Rust `READY_TASK` (candidate is currently `attempt_<lowercase BLAKE3 hex>`). HostKernel must validate/pin the same exact value through admission/handoff/replay; no model/request-supplied ID. This was agreed with P1/P2 and must appear in §37 managed dispatch flow.

2026-10-20 05:12 UTC — P1/P5 route integration: the five canonical keyless default routes need fixed remote MCP initialize/session/tools-call lifecycle; Brave needs GET. Existing Rust ExecutionHost HTTP supervisor is POST-only. Parent instructed P1 to add bounded MCP/GET capability inside the existing Guarded supervisor (no second runtime, arbitrary server, or bypass), with leases/receipts/cancel/UNKNOWN. Keep all route effects disabled pending source integration and later verification. This is required to satisfy P5's approved default cascade.

2026-10-20 05:16 UTC — P2 TaskTool review: quiescence delivery ID must be deterministic from exact Attempt/handoff/consume receipt and reused after restart, never random. Definite prompt returns with assistant/provider/tool error need durable nonterminal failed outcome + quiescence so they can be reconciled without provider replay; only ambiguous in-flight outcomes remain UNKNOWN. Outcome kind belongs in the child state digest. P2 is repairing; no tests/builds.

2026-10-20 05:20 UTC — P1 has source for five fixed anonymous MCP endpoints and bounded three-frame search lifecycle inside existing HTTP supervisor. This supersedes the prior “no MCP transport source” note, but the code is transport-only: HostKernel Guard batch admission, one-use lease consumption, durable aggregate receipt and UNKNOWN recovery are still missing, so no search effects are enabled. P5 must compose only through this transport and HostKernel support list. No tests/probes.

2026-10-20 05:23 UTC — P2 created `managed-run-coordinator.ts` for Rust-selected candidate→admission→claim→consume→Task child prompt. Parent made the first-party source Git-visible with exact `.gitignore` exceptions. Current source search found no actual external caller from goal.start/control/TUI yet; P2 must wire the accepted Run control path before claiming a vertical. No tests.

2026-10-20 05:26 UTC — P2 coordinator stops after prompt-return/quiescence and still needs the actual current workspace revision, artifact/evidence, authenticated distinct verifier, criterion evidence and terminal settlement path. P5 added `websearch-runtime.ts` product composition but its imported provider factory source is still pending; runtime remains fail-closed until HostKernel receipt dispatch and P6 SecretBroker. Parent exposed new first-party sources with exact ignore exceptions.

2026-10-20 05:30 UTC — P1 added fixed request construction for MCP, BYO POST and Brave GET to the shared HTTP supervisor. Managed quiescence now recomputes P2's output/outcome receipt fields. This is transport source only; no Guard/lease/durable HTTP intent/aggregate receipt/recovery or P6 SecretBroker connection is yet accepted. Keep routes disabled and run no tests until source phase is complete.

2026-10-20 05:32 UTC — P5 now has concrete adapter/parser/runtime source, including per-attempt protected Attempt scope, fixed route request mapping, support-list filtering, truthful read-only inspect, and search tool invocation. Parent exposed new files in `.gitignore`. Cross-phase issue sent to P1/P5: every cascade/failover/retry subrequest must have proper atomic pre-admission and its own one-use effect receipt or an explicit aggregate Guard intent; no one lease reuse and no retry after uncertain dispatch. Search remains disabled pending P1/P6; no tests/probes.

Current continuation — P1's final search contract is one `execute_search_cascade` RPC after canonical ToolBatch admits/approves the exact full trusted route plan. This is one aggregate Guard effect/lease/intent/receipt consumed once; HostKernel records bounded per-route attempt/subreceipt provenance beneath it. Definite outcomes may fail over only within the approved route order; UNKNOWN stops. P5 is adapting to the exact admitted plan. P2 connected accepted `goal.start` to its coordinator behind the disabled runtime flag and is wiring current-revision evidence, distinct TUI-approved verification, terminal settlement, and P8 settlement. P1 has also registered the authenticated read-only `managed.active_attempt_recovery` projection scoped to Goal/Run/root Session/Location/epoch/revision; P2 is wiring no-replay Core reconciliation. No verification yet per the source-first instruction.

P5 closed its unblocked source work PARTIAL; resume the same owner when P1 aggregate dispatch and P6 trusted SecretBroker refs land. P8 has been assigned a whole-phase owner for worker/resource/worktree/recovery integration. Active owners are P1/P2/P8; P3/P4/P6/P7/P9 are queued behind actual child slots. C: free space is 57 GB at `/mnt/c`, one worktree, no build/test processes. No tests/builds/typechecks/audits/benchmarks/live probes have been run; continue implementation first.

P8 source correction: HostKernel already has authenticated `resource.sample` with live Core peer and managed Attempt/Run/Goal/Location binding, OwnerLog watermark validation, Linux-only sampler, and truthful `NOT_ATTESTED` product status. This corrects earlier stale tracker claims of no production sampler route. No measured product baseline is eligible yet. P8 owner is auditing remaining phase-local worker/resource/worktree/recovery gaps.

P6 source continuation: SecretBroker now exposes bounded provider metadata lookup and
`Auth.searchCredentialRefs()` projects only one AVAILABLE opaque SecretRef for each fixed
BYO search route; missing, revoked, ambiguous or unreadable refs yield no BYO route, while
keyless routes can continue. This is a reference projection only, not a lease or dispatch
grant. Provider Doctor now has offline, catalog and full endpoint shapes; catalog/full report
SKIPPED with zero network and no credential access until P1 provides trusted Guard dispatch.
The TUI model picker now labels access-source configuration and catalog capability separately
from live endpoint health. P6 remains PARTIAL: secure credential-write UI/Guard integration,
live Doctor probes, full FEAT-001..014 integrated acceptance, provider/model switching journeys,
and free-model/coding-task acceptance remain open. No tests/builds/typechecks/audits/probes/
benchmarks/provider calls have run.

### 2026-10-20 05:19 UTC — current owner ledger

P2's active-recovery/no-replay sub-deliverable is source-wired, but P2 is not complete: current final workspace revision, complete independent verifier/evidence/settlement path and the end-to-end Guarded action still await P1/P8 integration and source review. P2 is queued to resume as the same phase owner when a slot opens.

P6 now owns full provider/model/settings/Doctor/S1 implementation. Active owners: P1, P6, P8. P5 resumes with the same owner after P1 aggregate guarded cascade dispatch and P6 SecretBroker refs arrive; P3/P4/P7/P9 remain queued. P8 keeps RC0 NOT_ATTESTED and rejects caller-supplied JSON trust. Required attestation is a typed authenticated projection bound to current final workspace revision, HostRun receipt, verifier evidence, Goal/Run/Session/Attempt and OwnerLog cursor. No validation has run, by user instruction. Preserve mixed unstaged state; C: has 56 GB free via `/mnt/c`.

2026-10-20 05:20 UTC — P1/P8 have an explicit non-overlapping proof API boundary: P8 owns `worker_durable.rs` and worker-pool proof/journal implementation; P1 owns HostKernel authenticated ingress and call sites. P8 is adding a final guarded Inspect pin builder and typed settlement getters; P1 wires the HostKernel call site. No settlement/RC0 eligibility until the exact GuardedWorktreeReceipt is durably present. Active phase owners: P1/P6/P8; P2 remains queued for full-phase completion. C: 55 GB free via `/mnt/c`; tree is mixed and unstaged; no tests/builds/typechecks run.

2026-10-20 05:21 UTC — P1 found that root worktree approval validation/digest are present but no HostKernel operation mints the private root scope/challenge (all CapabilityBinding paths remain `managed_root_scope=None`). P1 is implementing the only safe internal root scope from authenticated RootCoordinatorExecutionProof + P8 operation pin; create/inspect/release must stay unavailable until complete Guard/approval/lease/supervisor/receipt/recovery. No tests or acceptance claims.

2026-10-20 05:22 UTC — P1/P4 launch-profile split settled: P1 implements HostKernel selector/definition validation/Guard lease/single-supervisor dispatch and documents an authenticated RPC contract; P4 supplies the trusted Core Config resolver and LSP/DAP/REPL adapter. No caller executable paths and no second supervisor. Keep launches unavailable until both sides plus OS confinement are wired.

2026-10-20 05:23 UTC — P2 review gap: no `SubagentDeliveryV1` runtime envelope exists in package source yet. P2 owns implementation on resume: direct lane pins Core parent/child lineage, AgentProfileV2 revision/digest and effective permission-scope digest; managed lane pins Rust DelegationBinding + exact lineage; canonical owner recomputes domain-separated authorityDigest. P2 is not complete.

2026-10-20 05:25 UTC — P1 source added authenticated `execution.resolve_launch_profile` backed by an installation-owned selector map. It returns only immutable profileRef, executable digest and resolved status; no path/argv/env/spawn. This is not launch readiness. Remaining P1: Guard challenge/lease, same-supervisor preflight/spawn and receipt/recovery. P4 consumes an authenticated Session/Location/Attempt + exact definition/ref + capability + challenge/one-use lease; HostKernel recomputes profile digest/selector and derives cwd/env.

2026-10-20 05:26 UTC — Final launch contract: profile definition is only sent on authenticated `execution.resolve_launch_profile`; HostKernel pins its immutable result to the exact Guard PreparedEffect/challenge. Subsequent launch carries only the HostKernel-minted profileRef + authenticated Session/Location/Attempt + challenge/one-use lease. No caller executable path/argv or second mutable registry. Keep profile/executable digests in durable receipts and revalidate before spawn.

2026-10-20 05:27 UTC — P8 source advanced: final Inspect pin is derived only from exact active claim + verified registration/Create provenance + terminal revision/root proof. Verified Task settlement now requires the exact durable Inspect receipt and persists final revision, Inspect/Host receipt refs, verifier evidence/artifact refs and settlement watermark; six-field legacy replay remains supported with original digest schema. No tests run. P1 still must wire authenticated HostKernel inspect and RC0 projection; P2 must supply terminal verifier evidence. RC0 remains NOT_ATTESTED.

2026-10-20 05:28 UTC — C: is at 49 GB free / 90% used via `/mnt/c`; `kernel/target` 520 MB. A separate Windows PowerShell/Cargo validation in another project is active on C:. Preserve it and its outputs. No HorizonCode build/test process is active.

### 2026-10-20 05:30 UTC — active phase coordination
P6 is implementing authenticated owner-chain authorization for V2 question list/reply/reject. P7 owns shared `/event` filtering; it must exclude `question.v2.*` events unless the authenticated principal matches the server-owned Session/ancestor owner chain (bounded traversal; no request-supplied identity). P8 source boundary confirms logical child Attempts do not have individual PIDs or process-tree metrics; RC0 must not synthesize them. Token/cost charging remains P2/provider provenance work. Active source owners: P1 Guard/ExecutionHost, P6 providers/settings/S1, P8 resources/workers. P2 and P5 are queued for immediate resume when a slot opens; P3/P4/P7/P9 remain in the phase queue. No tests/builds/typechecks/audits/provider probes/benchmarks have run; defer them until implementation is complete. C: 49 GB free via `/mnt/c`; no HorizonCode build/test process; only the primary worktree is present.

2026-10-20 05:32 UTC — P1 source review: launch-profile resolution, immutable profile pin, Guard challenge and existing-supervisor preflight are now wired in HostKernel source. Parent found a lease-ID mismatch: `launch_execution` passes `terminal.run` to `consume_lease` for LSP/DAP capabilities, which would yield UNKNOWN after durable intent. P1 owns fix and later source-level acceptance for both `language.server.start` and `debug.start`. No checks run.

2026-10-20 05:34 UTC — P1 repaired the launch lease mismatch found at 05:32: `consume_lease` now uses the pinned capability (`language.server.start`/`debug.start` or `terminal.run`). The current backend projection explicitly denies unsupported hard CPU/memory/process-count/FD quota guarantees. The P1→P4 contract is authenticated `execution.resolve_launch_profile` with trusted Core `profileDefinition`, returning Guard challenge plus `profileRef`; post-approval prepare/launch carry only that ref and exact Session/Location/Attempt/challenge/one-use lease pins. REPL remains unavailable. Source only; no tests run.

2026-10-20 05:36 UTC — P6 owner-chain source + fixtures are now Git-visible through exact root ignore exceptions. P8 filled its missing reconciliation validator for final Inspect receipt, durable worktree registration/provenance and terminal revision, and sent P1 the exact typed settlement/HostRun receipt API. Remaining P8 integrations: P1 guarded Inspect + authenticated HostKernel projection; P2 final verifier and token/cost accounting proof. Keep RC0 NOT_ATTESTED; no tests/builds run.

2026-10-20 05:38 UTC — P5 agent dispatch was rejected by the platform thread limit. Parent is doing only independent P5 TypeScript/docs implementation; P1 retains all Rust HostKernel/EffectHost writes, P6 retains Auth/SecretBroker/settings/Doctor/question writes. HostKernel contract from P1: one `execution.execute_search_cascade` carrying exact admitted route order/query/retry/SecretRefs; bounded reply with per-route receipt refs; UNKNOWN stops. P5 runtime now preserves UNKNOWN as a distinct route status and projects fixed-route cost/auth provenance (`FREE/none` for keyless, `UNKNOWN/secret_broker` for BYO). Still fail-closed; no verification run.

2026-10-20 05:42 UTC — Verification/settlement order is fixed from §12/§17/§37: (1) coding prompt returns; persist quiescence only, Attempt stays EXECUTING and Task PENDING_VERIFICATION; (2) independently dispatch verifier as its own Guarded EffectIntent/one-use lease under the same live Attempt; (3) P1 captures supervised output, exact receipts/artifacts, and unchanged revision; (4) P2 appends typed evidence, then Task Verified/Attempt SETTLING; (5) P1/P8 perform final Guarded Inspect at evidence revision; (6) P8 settles logical worker using exact terminal P2 snapshot + final Inspect receipt. No worker capacity release before verification. P1/P2 were instructed to adapt their source; no checks run.

2026-10-20 05:44 UTC — Parent P5 source delta: preserve UNKNOWN attempt state, attach fixed-route cost/auth provenance, and persist route attempts in received order. Updated §37.5 and the operative plan. BYO Settings enablement is the explicit user consent; P1 Guard approval must also show UNKNOWN cost/auth and never reveal SecretRef. Dispatch remains unavailable pending P1/P6 integration. No checks run.

2026-10-20 05:47 UTC — P6 found legacy direct provider-key injection in provider adapters from Config/Auth/env. P6 owns fail-closed credentialed provider execution until the Guarded one-request SecretBroker transport, revocation, zeroization and leak acceptance are implemented; catalog and anonymous/free provider visibility remain, with truthful unavailable state. No tests or probes run.

2026-10-20 05:49 UTC — P1 added truthful per-route cost/auth in Guard approval with SecretRefs omitted. Parent P5 preserved UNKNOWN through route projection and final tool activity (`unknown`, not `exhausted`). No validation run.

2026-10-20 05:52 UTC — P2 SubagentDeliveryV1 decoder/schema are now visible in Git via exact exceptions. For usage charging, derive operation identity from assistant message ID + canonical `step-finish.index`; use actual event usageProvenance, bind provider/model, never request-supplied identity. P2 is implementing durable deduplication and stop-before-next-dispatch. No tests run.

2026-10-20 05:54 UTC — Architecture now records the integrated verification/final-Inspect order (§17.24) and explicit two-operation approval boundary (§17.23): prepare P8 pin/challenge → TUI approval → execute under one-use lease and durable marker/receipt → settle. Refresh root proof after every P8 append. P1/P2 implementation pending; no checks run.
### Continuation — source-only progress after the 05:54 UTC checkpoint

- Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings. The three child slots available to this session are full; other phases must be assigned as slots free up. No tests/builds/typechecks/audits/probes were run, per user direction.
- P1's final Inspect restart-recovery gap is concrete: P8's durable resolver can return a completed operation pin but not the durable Guarded receipt. Without a P8-owned opaque receipt accessor, a restart cannot safely finish settlement. P1 will not race P8-owned worker journal files.
- P2 is implementing child delivery and usage budget accounting. Parent ruling: canonical source identity is assistant message ID + step-finish index; TS MessagePack must encode owner epoch as the Rust canonical decimal string. Only actual provider-reported UsageProvenance may charge monetary budget; round conservatively to micros, persist/dedupe before another model dispatch, and stop when cost is unknown under an applicable ceiling.
- P6 supplied P5's exact trusted Auth contract: `Auth.searchCredentialRefs()` returns only one AVAILABLE opaque SecretRef per fixed provider route and omits ambiguous/missing/revoked refs. P5 remains fail-closed until P1's durable aggregate dispatcher and production SecretBroker composition land.
- Parent repaired the missing `WebSearchRuntime` namespace export in `packages/opencode/src/tool/websearch-runtime.ts`; no verification was run. Git state remains mixed and unstaged; C: last measured 49 GB free via `/mnt/c`; one primary worktree. V1 remains PARTIAL / NOT RELEASED.
- Parent found and documented an ordering cycle: P8 final-Inspect pinning cannot consume a terminal P2 Attempt snapshot if Inspect itself must precede worker settlement. The contract now uses a verified `SETTLING` candidate projection to pin Inspect; after its exact receipt, P2 emits the terminal Attempt snapshot and P8 settles from both. §§12.19, 17.24 and 37.22 were updated; P1/P2 were notified. P8's exact completed-Inspect receipt accessor remains a restart-recovery dependency.
- The user confirmed the architecture is finalized: reuse/adapt source patterns; do not redesign HLD/LLD. The attached file was read. Local OpenCode Task source shows linked child Sessions, inherited deny/external-directory rules, task-ID resume and bounded background lifecycle; Codex source shows root-owned tree membership, pre-spawn cleanup guard, explicit queued/trigger-turn deliveries, retained mailboxes and ownership-checked resume. §29 already contains these requirements plus HorizonCode's stronger Rust Guard/Attempt/evidence boundary. The P1/P2/P6 agents terminated on usage limits. Active owners now: P4, P7, P8. P8 source has switched final Inspect pinning to the typed P2 settlement candidate and added durable receipt lookup for exact restart recovery; §17.24 status is updated. P1 HostKernel and P2 Core integration must be re-dispatched as child slots free. No tests/builds/typechecks/audits/probes have run.

### 2026-10-20 06:08 UTC — phase ownership and immediate continuation

P4 released its slot PARTIAL after implementing `packages/opencode/src/lsp/launch-profile.ts` and updating §37.6/plan. Resume P4 after P1 dispatch/confinement, with trusted DAP profile projection and OS-enforced REPL limits also open. Active whole-phase owners are P1 Guard/HostKernel, P7 stream/artifacts/automation/rewind, and P8 workers/resources/recovery. P1 owns HostKernel; P7 owns `kernel/src/automation.rs` and `kernel/src/checkpoint.rs`; P8 owns `kernel/src/worker_durable.rs`. P8's final Inspect protocol now requires idempotency key `managed-final-inspect-{attemptID}` in preparation, receipt recovery, and settlement validation; P1 has this interface requirement. Added exact overlay exceptions for the P4 adapter and P7 event handler. No tests/builds/typechecks/audits/probes; C: 47 GB free via `/mnt/c`, `kernel/target` 520 MB. Git state remains mixed and unstaged. V1 PARTIAL / NOT RELEASED.
Continuation after this checkpoint: P7 completed its independent source assignment PARTIAL and released its slot. Source now includes the scope-scoped automation OwnerLog registry (`AutomationRegistryV1`), owner-chain `/event` filtering, and stricter replay resnapshot behavior; invocation and checkpoint RPC/capture/restore remain gated on P1 Guard/HostKernel. P2 whole-phase owner is active again. Source audit found P8 has a leased worker worktree but Core's managed Task Session and HostKernel managed effects still use the Goal Location/root workspace; no P8 worktree path reaches the child Session or EffectAttemptScope. P2 owns that Core binding; P1 owns HostKernel validation and route wiring. P1/P2/P8 are the active phase owners. P8 added a terminal-snapshot final-Inspect receipt resolver and is persisting stronger candidate/evidence identity. No tests/builds/typechecks/audits/probes. C: last P7 check was 45 GB free on `/mnt/c`; Git remains unstaged and mixed. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 — managed workspace binding integration checkpoint

Contracts and HLD/LLDs are finalized; current work is source integration against those contracts, not redesign. P1/P2/P8 are the three active phase owners. The key source mismatch is confirmed: Core managed child Session/effects currently use the Goal Location/root, but P8 reserves a separate managed worktree. P2 specified the required read-only P1 HostKernel projection: derive worktree ID/base and pool revisions, registered worktree Location/workspace ref, and current HostKernel-observed workspace revision from the live P8 reservation; caller supplies no path and receives no new authority. Core must use that exact Location for its child Session and effects. P1 has been tasked with this projection and direct coordination with P2. P8 has added a durable OwnerLog candidate pin binding final Inspect operation to the canonical full SETTLING candidate digest and exact candidate fields; legacy unpinned records fail closed. P1 must use `managed_final_inspect_root` and exact terminal receipt resolver. P4/P7 remain PARTIAL and parked pending HostKernel integration; P5/P6 and remaining V1 phases are still in the implementation queue. No tests/builds/typechecks/audits/probes run, per implementation-first instruction. Git remains mixed and unstaged; preserve it. C: has 45 GB free via `/mnt/c`; `kernel/target` 520 MB. Unrelated LiteCowork builds were observed and left untouched. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 — managed worktree projection timing correction

P1/P2 have finalized the shared DTO name and fields: `ManagedWorktreeTargetV1` under `worktreeTarget` with worktree ID, base/pool revisions, registered Location/workspace identity, HostKernel-derived canonical root, and current workspace revision. P1 source review found a timing requirement: the target is needed in admission/handoff before claim/settlement, so a resolver that only accepts a claimed worker or SETTLING candidate is too late. P8 is adding the read-only pre-dispatch resolver from authenticated root proof plus the exact live RESERVED/attached reservation and verified registration; later projections refresh current observed revision from trusted state. Request paths remain forbidden. This follows the existing P8 acquire/register-before-dispatch flow; no new design is intended. No validation was run.

P2 has now implemented the managed `SubagentDeliveryV1` envelope and Core-side `ManagedWorktreeTargetV1` decoding/validation in `task.ts`/`managed-control.ts`. P2 owns the adjacent LLM/prompt path to propagate the same trusted workspace reference into effect resolution. P1 owns Rust projection/HostKernel enforcement; P8 is adding the pre-prompt resolver from live RESERVED/attached state. These source changes remain untested and must not enable managed effects before the integrated Guard/lease path is verified.

P8 has now added the pre-dispatch `resolve_managed_worktree_target_for_attempt` resolver for live attached RESERVED/CLAIMED leases, validating P8 pins, attached DelegationBinding, verified registration/Create provenance and pool state without a caller path. It is a P8 target projection; P1 derives/registers the child Location and measures current revision, while P2 consumes the exact DTO. The final-Inspect candidate resolver remains separate. Source only; no verification.

Integration correction: P1 found a sequencing cycle in the first target projection: child Location/revision must be pinned into P2 Attempt admission, but an attached-DelegationBinding resolver runs only after that admission. The existing §37.22 order resolves it: after P8 `reserve_pre_admission`, P1 uses the opaque `ReservedWorkerLeaseProofV1` plus authenticated root proof/pins to resolve the registered worktree and current child workspace before appending Attempt/DelegationBinding; P8 then attaches the binding. P1/P8 are implementing this pre-admission resolver. Parent root SessionLink/Location remains separate from the child workspace. No validation run.

P8 resolved the admission cycle in source with `resolve_reserved_managed_worktree_target(root_proof, now_ms, pins, reservation)`. It is called after reservation and before P2 admission; it cross-checks the exact `ManagedReadyTaskPinV1` and opaque `ReservedWorkerLeaseProofV1`, verifies RESERVED/no-dispatch state, worktree lease, and verified Create provenance, and returns the HostKernel/P8-derived child target plus admission revision/current pool revision. The later attached RESERVED/CLAIMED resolver remains for refresh/recovery. P1 has been notified; no validation run.

P1/P2 integration is being widened beyond DTO projection: P1 confirmed admission must persist the child worktree Location and its independently measured initial workspace revision in P2 Attempt/DelegationBinding; the parent Root SessionLink/Location and parent workspace observation remain separate lineage facts. P1 will rebuild the post-admission HostKernel owner/binding from the child scope and compare it with the pre-admission P8 target. P8 must not treat the parent's source revision and the child's workspace revision as interchangeable or require implicit equality; it is aligning its durable pins/attach validation to the existing distinct-fact contract. This directly fixes the original effect-root mismatch. No checks run.

P8 owner returned PARTIAL after completing this wave's independent source work: RC0 schema v2 now binds samples to Session/Run/Task/Attempt; the pre-admission reserved-worktree resolver exists; final Inspect candidate pin/recovery is durable. Remaining P8 source integration is blocked on P1's exact authenticated child-workspace attachment shape, after which P8 must persist/replay child revision separately from parent-root revision and worktree base. RC0 remains NOT_ATTESTED; OS/resource baseline and real acceptance await the implementation/verification phase. P8 will resume as the same owner when P1/P2 supply the boundary. No checks run.

2026-10-20 — P6 offline Doctor source delta: the parent added a cache-only Config projection (`getOfflineProviderDoctorConfig`) and passes it to Doctor handlers. `InstanceState.has` prevents config initialization and therefore prevents remote well-known fetch from this path. The projection is allowlisted to provider IDs, model IDs, and allow/deny lists; secrets, headers, arbitrary provider options and URLs are excluded. A missing cached config remains UNKNOWN. `ModelsDev.getSnapshot` reads cache/bundled data; remote refresh is a separate explicit method. This is source-only, unverified; no tests/builds/typechecks were run. P6 remains PARTIAL.

2026-10-20 — Integration routing: P1's final Inspect execution request is already specified by §37.22; use `managed.execute_final_inspect` and the existing P8 APIs (`mark_worktree_dispatch_started_and_get_request`, `persist_worktree_receipt`, and candidate/terminal exact receipt resolvers), with fresh root proof after each append. P8 resumed as whole-phase owner for child Location/measured revision durable binding/replay; P1 must pass its typed `ManagedWorktreeAdmissionProjectionV1` into P8 attach. Parent-root source revision, child measured revision, and worktree base remain separate domains. P2 has exclusive `session/processor.ts` and `session/session.ts` for per-finish durable token/cost accounting before any next provider request. No checks run.

2026-10-20 update: P1's `managed_dispatch_admit` now passes `worktree_projection` into P8 `attach_managed_ready_task_binding` (`kernel/src/host_kernel.rs:4290`), so P8 can implement child revision persistence/replay against the real DTO. P8 was notified. Parent source scan still finds no HostKernel `managed.execute_final_inspect` route; P1 owns that remaining implementation using the existing §37.22 contract and durable P8 dispatch-start/receipt APIs.

2026-10-20 source refresh: P1's `managed.execute_final_inspect` route is now present. Parent reviewed its source and returned three blockers to P1 before acceptance: parent-root sandbox is broader than the child target, arbitrary P8 receipt resolver failures must not fall through to a fresh dispatch, and current child revision must be checked before any clean receipt is persisted. The current supervisor has a writable Git worktree metadata profile only; a read-only exact metadata scope needs the pending user decision. P8 now persists/replays the child-worktree admission pin. P2 now calls `managed.record_usage` at each LLM `step-finish`, stores provenance/receipt, refreshes scope, and stops the stream before another model step on STOPPED; Rust derives totals and applies the user-approved existing ceiling schema. No tests/builds/typechecks run.

### P2 usage/accounting source handoff — 2026-10-20
P2 source now binds profile-selected provider/model and optional profile tokenBudget in `DelegationBindingV1`, accounts each Core LLM `step-finish` through HostKernel `managed.record_usage`, and persists the exact Rust receipt/provenance before any next provider step. Rust operation identity is derived from Attempt + persisted assistant message + finish index; OwnerLog replay is idempotent. Effective token limit = minimum of accepted SpecVersion.maxTokens and pinned AgentProfileV2.limits.tokenBudget when present; cost limit = SpecVersion.maxCostMicros only. Core stops stream on STOPPED. P1 must still authenticate measured billing evidence, finish HostKernel route response compatibility and pass its guarded-origin/security checks. Tests/builds/typechecks remain intentionally unrun until implementation is complete. This is not P2 acceptance: distinct review, actual-workspace independent verification, restart/UNKNOWN/conflict recovery and end-to-end final revision evidence remain to be integrated and verified.

### 2026-10-20 — budget authority ruling
Use the existing schema. Managed token usage stops at the lower of accepted SpecVersion `maxTokens` and pinned AgentProfileV2 `limits.tokenBudget`. Cost usage is bounded by accepted SpecVersion `maxCostMicros` alone. No AgentProfileV2 schema extension is authorized. P2 owns applying this through durable accounting and recovery. This is a design decision, not verification evidence.
P2 direct child delivery continuation: `TaskTool` now persists the `direct_session` SubagentDeliveryV1 before calling the prompt adapter. Its authority is derived from the Rust-admitted DirectAttempt scope; resumed sessions strictly validate prior envelope/profile/permission lineage before advancing sequence. Managed delivery remains derived from Rust handoff and consume receipts. No tests run; this is source implementation, not acceptance evidence.

### 2026-10-20 — active owner roster after P8 source pass
P8 returned PARTIAL after implementing its currently unblocked lease/recovery/resource source. It records parent, admitted child, and worktree-base revisions separately; resolves typed targets before admission and after attachment; recovers exact candidate/terminal final-Inspect receipts; and includes authenticated Core sampling in bounded RC0 aggregation without claiming hard OS quotas. RC0 remains NOT_ATTESTED. P8 must resume for P1/P2 integration and later platform/real-work acceptance. P7 has resumed as `p7_stream_artifact_automation_full` for the entire P7 phase. Active source owners: P1, P2, P7. Do not run tests/builds/typechecks/audits/provider probes until implementation closes per user direction. C: 46 GB free via `/mnt/c`, kernel/target 520 MB. Git remains mixed, unstaged and uncommitted.

### P7/P1 integration seam (2026-10-20)
P7's source audit finds TUI cursor reconnect/replay, bounded artifact fidelity/storage/rendering, the Rust automation OwnerLog registry/journal, and checkpoint preview/receipt structures present. P7 continues independent source completion. HostKernel production routes remain absent for automation registry operations and checkpoint capture/preview/restore; same-boundary trusted dirty/untracked VCS facts are also missing, so restore preview correctly remains blocked and Core SessionRevert unavailable. P1 owns `host_kernel.rs` and received the adapter work under existing §37/§14.19 contracts. Effectful automation and restore stay closed until Guard admission, durable receipts and restart reconciliation are implemented.

### Current HostKernel integration findings (2026-10-20)
P1 is implementing the §37.5 aggregate web-search operation in HostKernel/EffectHost: a single aggregate durable HTTP execution consumes Guard once, records bounded ordered route subreceipts, and recovers UNKNOWN without replaying response bodies. Initial source supports fixed keyless routes; BYO stays denied until Rust can consume trusted SecretBroker one-use leases. P7's existing AutomationRegistryV1 and CheckpointJournalV1 APIs were sent to P1 for non-effectful/control and preview route integration; automation invocation and restore remain closed pending Guard/receipt/same-boundary VCS evidence. P2 identified that verifier approval uses the Goal root Location instead of the managed P8 child worktree Location; P1 must expose a trusted child LocationRef or prove routing ignores the request ref. P2 keeps verifier dispatch closed until this resolves. No verification has run.

### 2026-10-20 — P7 source recovery tightening
P7 changed stream-envelope seed behavior so a replacement source generation is not suppressed by the prior generation's sealed-ended marker. Checkpoint completion is now derived from a fresh opaque HostKernel no-follow observation matching all planned captured files (digest, size, executable bit, regular file, one link) plus exact Applied path receipts; the prior caller-supplied final-observation boolean was removed. P1 integration must call `record_restore_receipts(..., Some(&TrustedWorkspaceObservationV1), ...)` only after final observation; absence/mismatch stays UNKNOWN. This is unverified implementation source; effect paths remain unavailable.


### 2026-10-20 06:34 UTC — current implementation handoff

- Active whole-phase owners: P1 Guard/ExecutionHost/HostKernel, P2 managed vertical, P3 RepoIntel. P7 returned PARTIAL and released its slot after source-generation replay and exact-observation checkpoint settlement changes. P4/P5/P6/P7 integration/P8 integrated acceptance/P9 remain partial or queued.
- Parent source review: P1's `execute_search_cascade` continues after 401/403/407 and after bounded 408/425/5xx retry exhaustion, preserving per-route receipts; transport errors remain UNKNOWN. Managed verifier `approvalLocation` is derived from the admitted Attempt child Location and frozen final revision. P2 validates it and uses it to build the verifier LocationRef; the earlier root-directory mismatch is corrected in source.
- Remaining P1 integration visible in source: `automation.v1` has no HostKernel registry dispatch routes (only fail-closed `run_now`), and checkpoint capture/preview/restore routes are absent. P1 owns this. Invocation and restore remain unavailable pending canonical Guard admission, trusted same-boundary workspace/VCS facts, durable receipts and restart reconciliation.
- No tests/builds/typechecks/audits/provider probes run, per user instruction. Mixed Git state is unstaged and preserved; C: has 46 GB free via `/mnt/c`; no new worktree or cleanup action. V1 PARTIAL / NOT RELEASED.

2026-10-20 06:35 UTC — Parent/P2 source review settled another P1/P2 seam using existing §37.22/§17: `ManagedWorktreeTargetV1.workspaceRevision` is the immutable HostKernel admission revision; Attempt scope `workspaceRevision` is the current child workspace head and can advance only via exact Rust receipt transitions. P2 removed their invalid equality and now compares the entire immutable worktree target across scope refresh. P1 must preserve the pinned target and authorize live revision changes only from its authenticated receipt chain. No tests/builds/typechecks run.

2026-10-20 06:36 UTC — Managed verifier approval UI blocker: `DialogGoalVerification` holds the dialog while awaiting Guard approval, but `app.tsx` mounts Guard only for an empty stack and `DialogGuardApproval` clears the stack. P2 is implementing a scoped stacked approval flow for `source=host.managed_verifier` in `app.tsx`/`ui/dialog.tsx`; underlying verifier state must remain mounted and Guard decision must pop only its own layer. P7 has no active writer on these files. Source only, no UI checks yet.

P3 source delta: canonical `repo_detect` is wired over bounded existing RepoIntel reads; `references_find` and `definitions_find` use authenticated structure queries and remain typed UNAVAILABLE if no parser backend exists; symbol outputs retain workspace, generation/revision and node/file/parser provenance. Requested/effective index profile state is being carried through the RepoIntel seam with default Lightweight and typed narrowing reason; P6 owns config/settings precedence and P8 owns bounded pressure facts. Structural parser, genuine immutable buffer producer and atomic stale query-to-patch fence remain unverified/blocked by existing phase boundaries. No tests/builds/typechecks run.

## 2026-10-20 06:44 UTC — current implementation handoff

Continue the full V1 implementation; do not treat this note as a release checkpoint. Current active owners: P1 Guard/ExecutionHost/HostKernel, P2 managed vertical, P4 LSP/DAP/REPL. P3 RepoIntel returned PARTIAL; P5 agent dispatch hit the collaboration thread limit, so parent owns its independent TypeScript/runtime seam while P1 owns the Rust HostKernel search operation. P6, P7, P8 integration/acceptance, P9 and final integrated acceptance remain open. The user explicitly wants implementation before tests, builds, typechecks, audits or provider calls.

Latest source changes/findings: P1 now provides automation list/inspect/history and checkpoint list/preview routes; create/update/enable/disable are explicitly fail-closed because no Guard lease/receipt path is wired. Invocation, checkpoint capture and restore remain disabled; preview cannot pass without trusted same-boundary VCS facts. P1's aggregate web-search route now accepts authenticated ordinary direct sessions without Goal/Attempt; a direct Task Attempt remains denied pending the external-effect receipt transition. P5 parent change removes the incorrect “Attempt required” check in `tool/websearch.ts`; production tool/runtime remains disabled until the Core→HostKernel adapter, lease/challenge/Location pinning and Guard composition are complete. P3's RepoIntel source work is present, but parser, authenticated editor buffer, profile config and live freshness fences remain unavailable.

P2 owns the managed final-Inspect prepare/approval/execute/recovery path and the typed managed-root Guard approval event projection. P1 supplies HostKernel fields and keeps Rust paths. P4 owns LSP/DAP/REPL Core clients/config; P1 owns HostKernel protocol journaling and bounded event buffering. These remain fail-closed until P1 Guard/confinement and durable protocol work are implemented. Preserve the mixed Git tree and existing build cache. Last disk check: C: 46 GB free via `/mnt/c`; `kernel/target` 520 MB. Do not stage or publish ambiguous changes; user authorization covers exact verified task-owned paths only.

### 2026-10-20 06:51 UTC — implementation checkpoint

P1's HostKernel verification recovery now distinguishes the exact active states: SETTLING with durable evidence returns the existing settlement candidate/evidence/artifacts; approved but undispatched verification resumes the saved challenge set only when reviewer/owner/spec/final-revision/profile pins match, with original lease digests and no lease reissue. P2 is integrating this. User-selected budget authority: tokens use min(SpecVersion.maxTokens, AgentProfileV2.limits.tokenBudget); cost uses SpecVersion.maxCostMicros only. P2 owns the Core supervisor cancellation allowlist required by P5 search RPC. P4 continues bounded DTO/config work while guarded launch/protocol/REPL effects remain unavailable. No verification commands run. Mixed Git state is preserved; C: last measured 46 GB free via `/mnt/c`, kernel/target 520 MB. Overall V1 remains PARTIAL / NOT RELEASED.

2026-10-20 06:52 UTC follow-up: HostKernel verifier recovery includes `approvalLocation` from the exact registered child Location at the frozen final revision in NEEDS_APPROVAL, RESUME_EXECUTION and SETTLING responses. Existing approved set resumes with its original pins/digests and no lease reissue. P2 is integrating; P1 is updating §37. No verification run.

2026-10-20 06:53 UTC: The verifier restart contract is now recorded in domain §12.19 and runtime §37: NEEDS_APPROVAL, RESUME_EXECUTION and SETTLING evidence recovery use exact saved pins and child Location, never replay stale/consumed leases, and SETTLING is not terminal SUCCEEDED. P2 still must consume and verify the contract.

2026-10-20 06:54 UTC resource/process check: C: 45 GB free through `/mnt/c`; `kernel/target` 520 MB; no extra worktrees. Two active Cargo tests observed belong to the separate LiteCowork project and were not interrupted. No HorizonCode tests/builds/typechecks were started.

### 2026-10-20 06:55 UTC — P5/P2 source update
P5 adds fail-closed validation that HostKernel route attempts and selected provider are within the exact ordered user-approved route plan; retries require a recorded RETRYABLE_FAILURE. New acceptance cases are present but unexecuted. P2 wires final Inspect, clean receipt, authenticated settle and P8 release with P1's exact child approval Location. P1 still must provide exact receipt-first final-Inspect recovery for consumed challenges and idempotent terminal settlement recovery after Attempt SUCCEEDED. These are source changes only; no verification run.

2026-10-20 06:55 UTC P4 follow-up: strict LSP codeAction/rename proposal bounds, DAP action-to-Guard mapping, and generation-scoped REPL callback/recovery quarantine are source additions. Actual REPL and effectful launch stay unavailable because HostKernel REPL RPC and OS resource enforcement are absent. Tests have not run.

### 2026-10-20 07:00 UTC — managed verifier recovery clarification
A full Core retry can reuse P8's deterministic Inspect pin, obtain a fresh Guard challenge and explicit approval, then resolve the exact completed receipt without redispatch. The remaining Inspect gap is same-request transport replay after the consumed challenge; HostKernel must resolve the exact completed receipt before rejecting stale challenge state. Also close idempotent P8 `settle_dispatch` recovery when Attempt SUCCEEDED was durable before a crash/lost response. P1 owns Rust recovery; P2 consumes the typed result. No effect replay or new evidence is allowed. No tests/builds/typechecks run. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 07:01 UTC — P4 handoff / P8 resumed
P4 returned PHASE_PARTIAL after finishing independent source work: typed immutable protocol snapshots, bounded proposal-only LSP codeAction/rename, DAP command/capability and argument validation, and generation-scoped REPL callback replay/UNKNOWN controls. Effectful launch remains unavailable. Remaining dependencies: P1 HostKernel protocol journal/reply/Guard/confinement plus codeAction/rename capability mapping; P3 authenticated RepoIntel document ingress; P8/OS enforcement and Guarded REPL executor. P8 now owns its full remaining phase and P1/P2 integration/RC0 in the newly freed slot. Active children P1/P2/P8. Tests/builds/typechecks/audits remain deferred. V1 PARTIAL / NOT RELEASED.

2026-10-20 07:02 UTC — full subagent lifecycle gap assigned to P6
Source comparison of pinned Codex `core/src/thread_manager/{managed,shutdown}.rs` and `core/src/tools/handlers/multi_agents{,_v2}/` against Horizon §29.5/§29.13 and §37.9 confirms direct-session V1 still lacks durable child lifetime/control: queue-only message vs explicit follow-up, bounded activity/result/list/inspect/graph, wait that does not cancel, cancel fencing with observed cancelled/still-running/UNKNOWN, and bounded parent/child queues and limits. Existing TaskTool only runs one prompt turn. This is explicit existing architecture, not new design. P6 owns Core Session/TaskTool lifecycle and TUI projection; P2 managed Task/Attempt stays distinct; P8 provides capacity facts; P1 Guard gates spawn and all effects. Gate 7 now carries this acceptance. P6 queued until a child slot opens. No tests/builds/typechecks run.

### 2026-10-20 07:03 UTC — P1/P2/P8 recovery integration and direct-message decision
P8 added a typed pending-worktree-operation resolver: only authenticated `None` means no pending operation; stale, UNKNOWN, quarantined and completed states remain distinct errors. P1 now uses it before completed final-Inspect receipt fallback, preventing arbitrary errors from looking like first use. Exact same-epoch execute retry returns only its cached matching receipt; after HostKernel restart Core obtains fresh Guard approval for the same deterministic P8 operation and resolves the durable receipt before redispatch. P1 added read-only `managed.settlement_recovery`; P2 strictly consumes a unique terminal snapshot with exact durable verificationRunID/challengeSetDigest, final revision and evidence refs, then invokes only existing `settle_dispatch`. No release on read; ambiguity remains uncertain. Source only, no tests/builds/typechecks.

The user selected direct child delivery shape: canonical `agents.message` carries `deliveryMode: "queued" | "follow_up"`; do not add an `agents.followup` capability. §29, §37 and Gate 7 now say so. P6 owns its strict machine schema, Core queue/turn lifecycle and TUI projection when a child slot opens. Active children remain P1/P2/P8. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 07:08 UTC — current owner/dependency ledger (not verified)

Active child owners: P4, P6 and P8; actual child concurrency is three. P1 is the next queued whole-phase continuation; P3 and P7 follow. P2 completed source integration for this pass, while real-socket and recovery acceptance remains deferred until implementation closes. P5 remains parent-owned for Core transport/SecretBroker route composition. P9 and final release checks are open.

P1's latest source provides exact terminal settlement recovery, typed P8 pending-operation resolution, same-epoch exact-response replay and LSP query mappings; its broader protocol journal/event buffer, command Guard matrix, atomic ToolBatch recovery, and guarded automation/checkpoint effects remain open. P2 strictly consumes verifier IDs/digest, final revision and evidence refs, and reports success only after P8 RELEASED. P4 dependent launches/protocol/REPL remain unavailable pending P1/P3/P8 contracts; P6 child spawning remains gated on Guard and bounded capacity. No tests/builds/typechecks/audits/provider calls have run under the implementation-first hold. Git remains mixed/unstaged; C: 45 GB free via `/mnt/c`; `kernel/target` 520 MB; no new worktree. V1 PARTIAL / NOT RELEASED.

2026-10-20 07:10 UTC — P4 source now has bounded codeAction/rename proposal methods over an injected `read_document` bridge, with freshness checks and no direct writes; production document ingress remains a P3/P1 dependency. P8 corrected RC0 worker/Core aggregation and same-sequence conflict handling; source regression cases were added but remain unrun. P6 found the existing durable Core `SessionInput` inbox and safe-boundary promotion, so direct lifecycle will reuse it. Parent accepted P1's internal Guard contract: `agents.message` remains the sole public capability; private prepare/commit/inspect is bound to exact authenticated session/profile/scope/epoch/message/payload/mailbox/capacity pins, one-use authorization, durable receipt and UNKNOWN inspection. `follow_up` requires separate fresh-turn proof; no `question.ask` Guard bypass applies. §29/§37 updated. Core and Rust remain fail-closed until wired.

2026-10-20 07:12 UTC — P8 owner returned PHASE_PARTIAL; source has typed Inspect resolver and corrected RC0 worker/Core aggregation, while attested baselines, OS-enforced quotas and integrated P1/P2 acceptance remain. P1 resumed on the freed child slot. Active child owners are P1/P4/P6; P8 is queued for integrated acceptance after P1/P2. P1 owns Rust direct.message Guard prepare/commit/inspect and protocol buffering; P4/P6 remain on Core sides. No checks run.

2026-10-20 07:13 UTC — P5 current source is more integrated than the earlier checkpoint: ToolRegistry composes the production `WebSearchRuntime.node`; it sends one exact aggregate HostKernel cascade call, and the keyless Rust dispatcher/durable receipt/recovery are present. `WEB_SEARCH_RUNTIME_READY=false` remains, with no live verification. BYO needs P6 SecretBroker lookup plus P1 one-use consumption. §37.2 corrected. P4 has a reply-wire contract discrepancy with P1 (callback lease/challenge issuance and eventSequence pin); parent requested a precise resolution before P4 changes that wire. No checks run.

2026-10-20 07:14 UTC — P1 resolved the apparent P4 LSP callback wire conflict: each server callback gets a fresh Guard challenge/one-use lease after `protocol_read`; reply carries a new outbound `requestSequence`, its own exact Guard envelope, and nested buffered serverRequestID+method+result. HostKernel retains and correlates eventSequence internally. No DTO change; P4 continues with the existing contract, callback stays unavailable until P1 dispatcher acceptance.


2026-10-20 07:15 UTC — P6 direct-message API decision and runtime blocker: user selected public `agents.message` `deliveryMode: "queued" | "follow_up"`. Core may translate public `queued` to private HostKernel `queue`; queued only persists, while follow_up requests one serialized fresh child turn at a safe boundary and cannot alter an active request/token stream. P6 confirmed TaskTool's direct child still uses the V1 SessionPrompt transcript while Core's durable SessionInput inbox belongs to the V2 runner; writing to SessionInput directly would split history. P6 will continue independent whole-phase work; message dispatch remains unavailable until the correct durable inbox-to-child-runtime adapter and P1 Guard prepare/commit/inspect boundary are wired. Active child owners remain P1/P4/P6. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Preserve the mixed unstaged tree; C: has 45 GB free via `/mnt/c`; one primary worktree; no cleanup/pruning.


2026-10-20 07:17 UTC — owner handoff correction: P4 returned PHASE_PARTIAL after independent source work (LSP exact Guard method mapping and bounded callback validation, DAP unsupported-command denial, source-only regression coverage, §37.6 status); runtime acceptance still depends on P1 process/protocol/confinement, P3 authenticated document ingress, and P8 enforced REPL quotas. P4 is queued for resumption after those dependencies. The freed platform slot is assigned to whole-phase P3 RepoIntel; active owners are P1/P3/P6. P1's direct-message private DTO now fixes service `direct.message.v1`, prepare/commit/inspect, private `queue|follow_up`, nested authority pins, payload 1–16 KiB, capacity 1–32, and SHA-256 payload digest; P6 is aligning its adapter while preserving public `queued|follow_up`. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Overall V1 remains PARTIAL / NOT RELEASED.


2026-10-20 07:18 UTC — P3 bridge ownership: P3 resumed as whole-phase owner and may add only the authenticated `repo-intel.v1/read_document` service/adapter seam in `packages/core/src/session/supervisor.ts` plus new P3 bridge modules. Existing managed-control P2/parent edits in the shared supervisor file are protected; P1 has been asked to avoid that Core file during this lease and retains HostKernel/Rust ownership. P4 LSP files remain P4-owned; P3 must expose an adapter module or coordinate before touching them. No validation run.


2026-10-20 07:19 UTC — P5 Core credential-reference composition: parent wired `Auth.Service.searchCredentialRefs()` into the production `WebSearchRuntime.node` and exposed only the fixed BYO route IDs in its trusted supported-route projection. The existing Auth method returns only a unique AVAILABLE opaque SecretRef per fixed provider ID; broker errors/ambiguity omit routes, and no key bytes enter Core. `WEB_SEARCH_RUNTIME_READY` remains false; HostKernel presently admits keyless routes only, and P1's fixed BYO transport/one-use consumption plus integrated acceptance are still required. §37.2 updated. Source-only; no tests/builds/typechecks/audits/provider calls. Active phase owners P1/P3/P6; P4 PARTIAL/queued; V1 PARTIAL / NOT RELEASED.


2026-10-20 07:20 UTC — P1 security seam continuation: P1 added strict private `direct.message.v1` prepare/commit/inspect DTOs and the canonical `agents.message` Guard policy, but RPC routing/OwnerLog durability remain fail-closed. Automation dispatch was tightened so only list/inspect/history reach `automation_rpc`; create/update/enable/disable and run_now remain unavailable before effects without Guard/receipt paths. LSP protocol dispatcher/reply and direct message operations remain unavailable pending HostKernel journaling/recovery. Source only; no checks run.


2026-10-20 07:21 UTC — P3/P6 integration: P6 is adding the trusted Config repo-intelligence requested/effective profile projection as a P6-owned seam; P3 will consume it without editing Config ownership. P3 requested HostKernel stale RepoIntel node proof validation before `files.patch`; P1 asked for exact schema-derived ref/digest fields before changing the shared HostKernel DTO. P1 also found the search cascade recorded 429 `Retry-After` but advanced immediately despite §37.5 requiring bounded cancellation-aware cooldown; P1 is correcting the Rust route behavior. All remain source-only and fail-closed.


2026-10-20 07:22 UTC — RepoIntel stale-write evidence shape: P3 requested a stale node proof before `files.patch`. The canonical `RepoNodeRefV1` contains workspaceBinding, sourceGeneration, sourceRevision, optional overlayDigest, pathRef, fileDigest, nodeId/nodeKind/symbol, byteRange, and parserId/parserVersion; there is no separate opaque node digest. P1 will keep HostKernel DTO work owner-scoped and derive any binding digest from the fully validated schema plus authenticated live generation/revision. No patch request field can authorize a stale write.


2026-10-20 07:23 UTC — P6 RepoIntel settings seam: `FeatureExposure` is a boolean compaction toggle and cannot represent RepoIntel's requested/effective `lightweight|adaptive|full` modes. P6 is adding a dedicated Config/API setting with optimistic concurrency and a typed requested/effective/source/locked/unavailable projection for P3; changing the setting alone must not launch work or network activity. P6 owns §16; P3 consumes the projection and P8 supplies pressure narrowing. Source only; no validation.


2026-10-20 07:25 UTC — P1/P3/P6 source integration advances: P1 added `prepare_tool_batch.repoIntelFence` validation over query ID, generation/revision/workspace binding and exact path/file-digest refs, including authenticated live scope, bounded resnapshot and unique target matching; only root selector `.` is supported pending safe path rebasing. P3 added the authenticated Core `readRepoDocument` bridge and an LSP callback bridge for P4, and consumes P6's new Config profile projection. P6 source now has the Config-owned optimistic-concurrency three-mode setting, TUI selector and question owner-chain workspace ancestry denial. P1 also changed web-search 429 handling to cancellation-aware bounded cooldown and records effective retryAfter; cancellation during cooldown leaves aggregate UNKNOWN. Source-only, no tests run. Identified a transport-bound issue: document read max was set to 6 MiB, equal to RPC frame maximum; JSON string escaping/envelope could overflow, so P1/P3 are coordinating a smaller shared bound.


2026-10-20 07:27 UTC — parent integration rulings and source checkpoint (implementation only)

- **P6 `agents.message` ruling:** the user reconfirmed public `deliveryMode: queued | follow_up`; Core maps `queued` to private HostKernel `queue`. Parent source review requires private `directAttemptID` in authority pins for both modes because HostKernel has no child→Attempt index. HostKernel must re-resolve the exact durable admitted DirectAttempt and match parent/child/profile/effective scope/epoch/workspace. `queued` has no fresh-turn proof; `follow_up` additionally requires a fresh-turn DirectAttempt proof. P6 owns schema/Core/TUI and P1 owns the private DTO/HostKernel side. Both modes stay unavailable until the V1 child transcript has a durable safe-boundary append/ack API and the Guard journal/lease/receipt/UNKNOWN path is wired.
- **P3/P1 patch-fence integration:** P3 found that existing `apply_patch` prepares absolute operation paths, while P1's `repoIntelFence` compares normalized RepoIntel-relative paths. P1 is changing only the fence comparison to derive a canonical path relative to the authenticated registered root, rejecting escapes and ambiguity while preserving Guard operation paths.
- **RepoDocumentRead bound:** P3 schema/Core and P1 HostKernel now agree on a 1,000,000-byte body cap, leaving RPC frame headroom.
- **Active whole-phase owners:** P1 Guard/ExecutionHost/HostKernel, P3 RepoIntel and P6 settings/providers/Doctor/S1/direct child lifecycle. P4 remains PARTIAL and queued; P2/P5/P7/P8/P9 and final integrated release gates remain open. The three actual child slots are occupied; no extra concurrency is claimed.
- **Implementation-first hold:** no tests, builds, typechecks, audits, provider calls or probes were run. These source changes have not been accepted or verified. Git remains mixed and unstaged; C: has 45 GB free via `/mnt/c`, `kernel/target` is 520 MB, and only the primary worktree exists. V1 remains PARTIAL / NOT RELEASED.


2026-10-20 07:29 UTC — P1/P3 patch-fence interface resolved in source: HostKernel now derives a normalized RepoIntel-relative comparison path from each existing absolute `files.patch` operation under the authenticated canonical registered root. The Guard operation path remains unchanged; root escapes, non-normal components and ambiguous targets are rejected before admission. This closes the source-level adapter mismatch, not acceptance evidence. P1 confirmed it will add P6's required exact `directAttemptID` pin and durable owner re-resolution. No tests/builds/typechecks/audits run.


2026-10-20 07:32 UTC — P3/P1/P6 interface updates (source only): RepoDocumentRead is now capped at **131,072 bytes** in the P3 schema/Core; P1 is aligning HostKernel. Worst-case JSON escaping is about 786 KiB, leaving frame headroom under the 1 MiB LSP bound. The P3 LSP document-reader adapter was hidden by the root `*` overlay rule; parent added its exact `.gitignore` exception, and Git now reports the source as untracked/visible (not staged). P1 now requires and resolves exact `directAttemptID` for both message modes, includes it in authority digest, validates the persisted OwnerLog's principal/session/epoch/profile/scope/workspace/head, and denies non-EXECUTING child Attempts. Message RPCs still return unavailable until Guarded mailbox durability, Core V1 transcript append/ack, and follow_up safe-idle proof are implemented. No tests/builds/typechecks/audits run.


2026-10-20 07:35 UTC — follow-up integration requirements: the P3 schema now models RepoIntel patch targets as exactly one existing-file digest or `expectedAbsent: true` destination proof. P1 must accept only those strict shapes and revalidate absent destinations under authenticated root/revision (the current HostKernel parser still requires `{pathRef,fileDigest}`). Parent approved this source contract for adds/moves. The P4 LSP client currently requests 6 MiB while RepoDocumentRead allows 131,072 bytes; P3 is clamping within its new Core→LSP bridge so the authenticated request remains within the shared cap. `apply_patch` UI/schema description must name both forms. No tests/builds/typechecks run.


2026-10-20 07:37 UTC — P1/P3 RepoIntel fence now agrees on source: HostKernel accepts only the strict XOR source-ref forms `{pathRef,fileDigest}` or `{pathRef,expectedAbsent:true}`. It validates existing digests against the authenticated live generation; expected-absent targets are checked under the registered root with component-wise no-symlink/real-directory validation and a final workspace-revision recheck. Absolute Guard patch paths are retained and only mapped for RepoIntel comparison. P3 updated schema/UI description and clamps LSP document reads to 131,072 bytes. No validation run.


2026-10-20 07:39 UTC — source checkpoint and phase-slot update: P1 has now set HostKernel RepoDocumentRead to 131,072 bytes, matching P3 schema/Core. P1 also added operation coherence: expected-absent refs must match `write` operations with null expected-before; digest refs must match writes/deletes with a prior digest. This supersedes the 07:35 note that Rust still required only file digests. P3 returned **PHASE_PARTIAL** after exhausting independent source work; remaining P3 dependencies are P4 LSP composition, P8 resource-pressure narrowing, a trusted unsaved-buffer producer and approved structural parser/index. One child slot opened and is assigned to the whole P8 phase; active owners are P1/P6/P8. P6 found a missing Config-owned RepoIntel profile compare/write implementation used by its own routes/UI and is restoring it before resuming child status projection. No tests/builds/typechecks/audits run; C: remains 45 GB free via `/mnt/c`, kernel/target 520 MB.

Source integration update (2026-10-20): P1 now gates the aggregate web-search RPC behind optional `execution.v1.web-search-cascade` plus `effects.v2`; Core requests and checks both features before sending it. The global production runtime switch remains false pending acceptance, and the handshake covers only fixed no-key routes. Rust's existing managed accounting source already uses `min(SpecVersion.maxTokens, AgentProfileV2.limits.tokenBudget)` and SpecVersion-only maxCostMicros. No verification was run.

Implementation follow-through (2026-10-20): P5 carries the Guard-pinned opaque SecretBroker route refs through its aggregate request and checks negotiated cascade plus effects features before dispatch; runtime remains fail-closed. P8's pressure projection is now source-present in Rust and documented, while live pressure ingress, persistence/recovery and P3 consumption remain unfinished. P2 has been assigned the available phase-owner slot. No verification was run.

Phase allocation update (2026-10-20): active child owners are P2, P6, and P8. P1 handed back PHASE_PARTIAL and is next in queue for its durable Guard/ExecutionHost/protocol gaps; P3/P4/P7/P9 remain queued/partial, while P5 is parent-owned for its Core runtime. Final HorizonCode typecheck, tests, overlay/architecture audits, adversarial/recovery matrix, release gate and publication remain unrun. Git is mixed and unstaged; C: has 45 GB free via `/mnt/c`; `kernel/target` is 520 MB; the primary worktree is the only worktree. The foreign LiteCowork Cargo test remains untouched.

Reference-source follow-up (2026-10-20): local Codex source confirms separate QueueOnly/TriggerTurn modes, root-scoped lineage, bounded spawn/resume, process-local mailbox/watch, best-effort parent result delivery, explicit interrupt and spawn-edge rollback before accepted initial input. OpenCode TaskTool remains the direct Core child pattern. §42.12 records these exact take boundaries; P6 is assessing the missing partial-start cleanup behavior. P1/P6/P8 are active; P2 is partial awaiting P1/P8 integration. No tests/builds were run.

Source audit update (2026-10-20): P2 is PHASE_PARTIAL after source review; the plan response now correctly requires `goal.start`, and managed finalization remains dependent on P1 verifier/Guard evidence and P8 settlement. P8 tightened `settle_managed_worker` so only exact SUCCEEDED+VERIFIED can reach the capacity-releasing event; non-success terminal states cannot release. P1 has resumed; active child owners P1/P6/P8. Changes remain unverified, with no tests/builds run.

2026-10-20 07:42 UTC — continuation checkpoint: active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1/direct lifecycle, and P8 resources; all three actual child slots are occupied. P2 remains PHASE_PARTIAL pending P1/P8 integration. P3/P4/P7/P9 and final integrated implementation/release work remain open or queued; P5 is parent-owned and fail-closed. P6 changed direct delivery outcomes to start QUEUED, become EXPIRED only before prompt invocation, and become UNKNOWN after prompt invocation or acknowledgement-persistence ambiguity; child history is retained and no unsafe lineage detach/delete is attempted. P1 hardened terminal.start so post-admission persistence failures are UNKNOWN and never reported as RUNNING. P8 is implementing a bounded pinned-cache eviction planner; success settlement remains SUCCEEDED+VERIFIED-only, while a separate failure release must follow §11.20/§18.18 owned-process termination and settled-effect reconciliation; V1 logical children share Core and cannot claim per-child PID termination. Public child messaging is `agents.message` with `deliveryMode: queued|follow_up`; bounded named-child wait is read-only and timeout never cancels. No tests/builds/typechecks/audits run. Git remains mixed, unstaged and ownership-sensitive; only the primary worktree exists; C: 45 GB free via `/mnt/c`, `kernel/target` 520 MB; the unrelated LiteCowork Cargo test remains untouched. HorizonCode V1 remains PARTIAL / NOT RELEASED.

2026-10-20 07:49 UTC — parent continuation handoff: User selected `agents.message` with public `deliveryMode: queued|follow_up`; P6 has been told to implement queued durable enqueue-only and follow_up as one serialized fresh turn at a safe boundary. Source delta: P6 now reauthorizes the parent/workspace chain on each wait poll and matches the exact HostKernel DirectAttempt scope pin. P1 now denies unsupported ToolBatch capability IDs before preflight and keeps failed/cancelled managed capacity from success settlement; P8 quarantine-only reconciliation proof remains in progress. P5 removed an unmeasured `latencyMs: 0` result field to comply with truthful provenance. Active whole-phase owners P1/P6/P8. P2 partial; P3/P4/P7/P9 and final integration/release open; P5 parent-owned. No checks run. Do not enable dependent effects pending acceptance. Git mixed and unstaged; C: 45 GB free via `/mnt/c`; one primary worktree; foreign LiteCowork test untouched. V1 PARTIAL / NOT RELEASED.

2026-10-20 07:51 UTC — parent source audit: P1 now counts all direct child reservations per authenticated parent Session across profile revisions with a durable 64-child hard ceiling, under the admission OwnerLog lock and replay validation. Terminal children count; only abandoned never-created Attempts are excluded; profile-specific total and active limits still apply. This closes the profile-switch aggregate bypass at source level; P6 is aligning Core and §29.13. P1 also integrated P8's quarantine-only terminal path for exact failed/cancelled Attempt snapshots; it retains capacity/worktree and makes no child process-exit claim. P8 is tightening fresh release reconciliation proof. Parent corrected stale search implementation status in §16.7/§42 and removed fabricated zero latency. No validation run; implementation-first hold remains. Three active owners P1/P6/P8; V1 PARTIAL / NOT RELEASED.

2026-10-20 07:53 UTC — P6 returned PHASE_PARTIAL; parent immediately assigned the freed child slot to the entire P7 phase. P6 source delta: direct child status/wait has exact parent-linked filtering, per-poll owner/workspace reauthorization and exact Attempt pins; 64-child aggregate early admission count; local-only offline Provider Doctor facts; provider capability projection; RepoIntel setting; and S1 ownership checks. Remaining P6 direct-message dispatch, live Doctor/BYO and question filtering depend on P1/P7 seams; live provider tests and final acceptance are deferred by user instruction. Active phase owners P1/P7/P8. P1 aggregate cap now counts unique `(parentSessionID, childSessionID)` pairs across profile revisions, with safe repeat/resume semantics; terminal distinct children count. P8 quarantine path remains separate from release proof. No checks run.

2026-10-20 07:55 UTC — P8 now requires a fresh, durable quarantine-release proof: prior terminal settlement + quarantine receipt + current owner/root and terminal snapshot + HostKernel child quiescence digest + current Guarded Inspect receipt pinned to the live registered worktree/root. UNKNOWN/MISSING keep capacity; dirty worktree remains quarantined even if ActiveWorkers is released. P1 must integrate this new API; prior P1 partial handoff has been resumed. P7 is active as whole-phase owner and has exclusive `artifact_store.rs`, `automation.rs`, `checkpoint.rs` plus P7 Core/TUI/schema; P1 owns Guard/HostKernel/effect_host/protocol; P8 owns worker/resource/worktree accounting. No checks run. Active P1/P7/P8; V1 remains PARTIAL / NOT RELEASED.

2026-10-20 07:58 UTC — P5 source correction: after an aggregate search RPC is invoked, any lost reply/interrupt is now reported UNKNOWN, never exhausted; local serial successors stop and no route retry occurs. Explicit HostKernel refusal is UNAVAILABLE. Successful latency is a monotonic Core→HostKernel round-trip observation, not provider-server time. Exact durable inspect/replay of a lost search response remains a P1 seam; keep search closed. Pending user decision on §37.5's per-URL content-cache requirement, since `web.search`/WebSearchRequestV1 return links only with no fetch or bypass contract; independent phase work continues.


2026-10-20 08:04 UTC — P5 V1 scope ruling and continuation: `web.search`/`WebSearchRequestV1` return bounded links/snippets and define no page fetch or cache-bypass input, so the §37.5 per-URL page-content cache is deferred post-V1; V1 must not fetch/cache content implicitly. The normative text now records that boundary and the explicit contract needed before future page retrieval. P1 is adding a read-only exact-authority `inspect_search_cascade` for lost RPC replies; it may reconcile status/receipts but never re-execute. A settled success with an unrecoverable response body must be surfaced as “completed, results unavailable,” distinct from unsettled UNKNOWN and exhaustion. P7 asked P1 to assess authenticated owner/CAS automation definition CRUD while leaving `runNow` disabled; parent passed the request to P1. P7 source fixes include accurate artifact pending failure and live raster-cache gauge aggregation; effectful artifact/automation/checkpoint paths remain Guard-gated. Active whole-phase owners P1/P7/P8. No tests/builds/typechecks/audits/provider probes run; user deferred them until implementation is finished. Git remains mixed/unstaged (13 commits ahead); C: has 45 GB free via `/mnt/c`, `kernel/target` 520 MB, one primary worktree. Overall HorizonCode V1 remains PARTIAL / NOT RELEASED.
### 2026-10-20 08:16 UTC — active continuation / boundary

- User boundary: operate only inside `/home/sarvesh/business_Dev/agentx`. Root `AGENTS.md` binds the parent and every phase owner; task files/output stay inside the repo, no external paths or external-service operations (including Git remotes). This supersedes prior C: `/mnt/c` checks while active. The user-supplied attachment path is outside the boundary and must not be accessed.
- Active whole-phase owners: P1 Guard/ExecutionHost/HostKernel, P7 streaming/artifacts/automation/checkpoint, P8 resource/worktree lifecycle. All three available child slots are occupied.
- P5 source increment: Core carries HostKernel-minted `routePlanDigest` through the strict Guard approval projection only for `web.search`; transport-loss handling invokes read-only `inspect_search_cascade` with the original challenge, location, lease, approved-argument digest, route-plan digest and optional Attempt pins. It does not redispatch. P1's matching HostKernel RPC remains in progress. Keep `WEB_SEARCH_RUNTIME_READY=false` until P1/P5 acceptance.
- No tests, builds, typechecks, audits, or provider probes were run in this continuation. Current Git remains mixed, unstaged, with 13 commits ahead of `origin/main`; do not push or stage broadly under the repo-only boundary. V1 is PARTIAL / NOT RELEASED.
### 2026-10-20 08:20 UTC — latest source handoff

- P7 added read-only checkpoint Core/HTTP list source. Parent exposed exactly those three owned source paths in `.gitignore`; checkpoint preview remains internal until same-boundary dirty/untracked evidence is trustworthy.
- P8 reports root-coordinator reauthorization plus Guarded fresh Inspect intent/receipt reconciliation source; cache freed-byte estimates become unavailable when inputs are unknown or overflow. P1 is implementing matching HostKernel authenticated prepare/execute DTOs without releasing workers on Inspect alone.
- P1's `inspect_search_cascade` implementation is source-present and matches P5's Core recovery adapter. P1's earlier `cargo check --lib` attempt reported 139 diagnostics across the dirty shared Rust crate; this is not a green check or phase evidence. Agents have been told to defer more validation until the implementation wave finishes.
- Repo-only boundary remains active; no outside files or remotes accessed. Active phase owners P1/P7/P8. V1 remains PARTIAL / NOT RELEASED.
### P5 typed-error recovery correction — 2026-10-20 08:21 UTC

Core no longer treats every typed HostKernel refusal as proof of no dispatch. Only `feature_not_negotiated` is classified as pre-operation/pre-dispatch. All other typed errors attempt exact-pin `inspect_search_cascade`; if reconciliation is unavailable, the outcome stays UNKNOWN and no route is retried. Source-only, not validated.

### 2026-10-20 08:24 UTC — continuation

- Read the user-requested attachment; no further outside-repo reads or operations are authorized by this continuation.
- P1/P8 reconciliation must preserve separate Session identity domains: managed Attempt owner/admission pins identify the child Attempt Session, root coordinator registration pins identify the root Run `SessionLink`, and the persisted child prompt-quiescence proof binds the child's parent to that root. §17.24 now states this explicitly; P1 and P8 have the source-level resolution.
- P7 checkpoint test is now explicitly Git-visible. P7 removed TUI/command actions for automation mutations that HostKernel rejects and updated §31.20; preview remains unavailable until an atomic same-boundary VCS/workspace observation contract is implemented.
- Implementation-first hold remains: no tests/builds/typechecks/audits/provider probes in this continuation. Active phase owners: P1 Guard/ExecutionHost, P7 streaming/artifacts/automation/checkpoint, P8 resources/worktrees. Git remains mixed and unstaged; preserve it. Repo-only boundary remains active; V1 PARTIAL / NOT RELEASED.

### 2026-10-20 08:24 UTC — phase-slot correction

P7 returned PHASE_PARTIAL with its remaining dependencies explicit; its checkpoint preview and restore/automation effects remain gated. The freed child slot now belongs to the full P2 managed vertical. The live child roster is P1/P2/P8. P3/P4/P6/P7/P9 plus parent P5 and final acceptance/release remain open or partial. Implementation-first hold remains; no checks run. Repo-only boundary active, mixed Git state preserved, V1 PARTIAL / NOT RELEASED.

P5 source reuse note (2026-10-20 08:24 UTC): inspected pinned local OpenCode's actual `websearch.ts` and `mcp-websearch.ts` again. Its single-route selection and direct Core HTTP executor are rejected for Horizon; fixed provider protocol/schema and bounded parser patterns are the reusable behavior. Horizon keeps user-ordered explicit cascade and Rust Guard/ExecutionHost/SecretBroker authority. The §42 provenance row now captures this precisely. P5 remains PARTIAL; no tests or live probes run.

### 2026-10-20 08:26 UTC — P1/P2/P8 source handoff

P1 now has source for Guarded quarantine reconciliation Inspect prepare/execute, child-root fixed Git observation, exact P8 receipt replay and post-execution revision equality. P8 has aligned child Attempt owner vs root Run SessionLink identities. P1's fresh-process no-live callback/command proof remains an implementation item; keep reconciliation release gated and UNKNOWN quarantined until it exists. P2 reports its main reviewer/goal.start/profile/worktree/accounting/TUI/verifier adapters source-present and is continuing a complete source audit for restart, stale review, artifact and human-edit conflict gaps. Active whole-phase owners P1/P2/P8. No checks run. Repo-only boundary; mixed unstaged state; V1 PARTIAL / NOT RELEASED.

### 2026-10-20 08:27 UTC — P2 full source audit (not acceptance)

P2 reviewed the full §12.19/§17.24/§37.22/§32.38 path against current Rust, Core, HTTP and TUI source. Unblocked P2 adapters are source-present: reviewer identity is derived from authenticated ServerAuth and Rust rejects proposer/self-review; `goal.plan` is inert and `goal.start` starts only the exact accepted persisted plan; AgentProfileV2 is pinned through Rust Attempt admission and P8's registered child-worktree Location/revision; usage is durably accounted before the session processor may dispatch another provider request; child prompt return is separate from verifier evidence; and success requires current-revision artifact evidence, P1's exact final Inspect receipt, P2 terminal settlement and P8 release. API/TUI project `PROMPT_UNKNOWN` separately and fence prompt replay; §37.22 now documents that state.

Remaining P2 phase acceptance depends on upstream integration: P1 confirms the verifier adapter remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE = false`) until Guard/confinement/restart recovery acceptance; P1 must complete fresh-process proof for no live callback/owned command; P8 settlement requires P1's opaque quiescence/Inspect proof and exact terminal Attempt. P8 confirms the P2 candidate→final Inspect→terminal snapshot→settlement sequence matches its contract and requested no P2 API change. P7 owns broader artifact lifecycle acceptance. Existing source tests cover reviewer spoof/staleness, UNKNOWN/restart, revision changes, artifact bindings and settlement paths, but have not been run or accepted on this integrated revision. Keep managed dispatch and verifier flags disabled. Repo-only boundary and mixed unstaged Git state remain active; V1 is PARTIAL / NOT RELEASED.


### 2026-10-20 08:31 UTC — phase-owner reconciliation

P2 returned PHASE_PARTIAL after fixing the managed child output receipt digest to BLAKE3 (direct Attempt result payloads remain SHA-256) and aligning verifier UNKNOWN decoding with HostKernel's bounded `reason` and exact final revision. P2 reports no independent source gap; integrated acceptance waits for P1 Guard/verifier/restart proof and P8 final-Inspect receipt recovery/capacity settlement. P1 returned PHASE_PARTIAL and is resumed for the complete remaining Guard/ExecutionHost scope, especially durable fresh-process no-live-callback/process proof, effect-origin denial/mediation, receipt recovery and direct-message Guard plumbing. P6 now owns the complete Providers/Settings/Doctor/S1 phase, including its bounded SecretBroker reference projection consumed by P5. P8 continues the full resource/worktree phase. Active owners: P1/P6/P8. Codex/OpenCode lifecycle source review confirms the existing Horizon contracts cover pre-spawn reservation/cleanup, bounded event/mail flow, cancellation, and explicit follow-up; no second runtime/process-local mailbox authority is adopted. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Repo-only boundary active; Git mixed/unstaged; V1 PARTIAL / NOT RELEASED.

### 2026-10-20 08:37 UTC — phase-slot refill

P1 source-fixed the two Inspect paths to persist RUNNING immediately after launch and preserve UNKNOWN if persistence fails. Its audit confirms no durable whole-tree exit proof survives HostKernel restart with the current stdio supervisor; do not clear quarantine or capacity without authenticated tree-exit evidence. The 64 distinct child-session aggregate admission cap is already durable. Protocol/message delivery remains unavailable without transcript append/ack and durable journal/replay. P8 completed independent source work and reports remaining dependencies on P1 fresh-supervisor proof, P6 ResourcePolicy projection, P3 cache/pressure consumer, and absent safe retention/compaction semantics. P3 RepoIntel and P4 LSP/DAP/REPL are now assigned full-phase owners; P2/P6 continues. No validation commands run. Repo-only boundary, mixed Git state preserved; V1 PARTIAL / NOT RELEASED.

### 2026-10-20 08:38 UTC — P5 cascade receipt fence

Parent P5 now rejects any route attempt after a HostKernel attempt marked UNKNOWN, alongside the existing stop-after-success rule; one regression case was added without execution. Search remains disabled pending full P1/P5/P6 integration and acceptance. Active full-phase owners are P2/P6, P3 RepoIntel, and P4 LSP/DAP/REPL. P1 full Guard/ExecutionHost continuation is next when a child slot opens; P7/P9 and cross-phase integration remain outstanding. No validation was run; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 08:39 UTC — P5 receipt consistency

Core also rejects contradictory aggregate UNKNOWN plus success evidence and requires a final successful route receipt before accepting `RECONCILED_RESULT_UNAVAILABLE`. Focused regression cases are source-only and unrun; search remains gated.

### 2026-10-20 08:40 UTC — canonical resource contract

P6 corrected the naming/interface mismatch: canonical `ResourcePolicyV1` retains §18.18 shape; Config/UI/API uses `ResourcePolicyProjectionV1` for requested/effective/status metadata, with canonical `ResourceLimitV1` only nested when facts exist. No effective values are fabricated. P8 was notified to consume absent+UNSUPPORTED as no enforceable cap.

### 2026-10-20 08:41 UTC — P4 handoff / P1 continuation

P4 returned PARTIAL after source fixes for 128 KiB LSP document reads, DAP payload/exception validation and exact TS/Rust launch/protocol DTO parity. It kept all process/protocol/REPL effects unavailable. Remaining P4 dependencies: P1 durable journal/event replay, Guarded supervisor and OS confinement, plus P3 authenticated document reader; no tests were run. P1 has resumed full-phase work and will align Rust patch-fence `sourceRefs` max 64 with the TS schema and actual files.patch bound. Active owners: P1, P2/P6, P3. P7/P8/P9 and integrated acceptance remain queued.

### 2026-10-20 08:42 UTC — P3/P6 source checkpoint

P3 source added cache TTL, pin-aware deferred release and owner-only generation eviction/events; accounting reports source snapshots and `reclaimedBytes:null`, not physical RAM reclamation. P8/P1 authenticated HostKernel bridge remains blocked, so no second registry is introduced. P6 has tightened default OpenCode model eligibility to explicit zero pricing across input/output/cache/tier, active availability and user-safe dispatch; no eligible free model means no default, never paid fallback. No tests/probes run; V1 remains PARTIAL.

### 2026-10-20 08:43 UTC — P1 unknown-capacity fence

P1 now counts UNKNOWN stdio/HTTP executions against capacity after interruption/restart until authenticated reconciliation. The Rust RepoIntel patch fence now uses the same 64-reference maximum as TypeScript and files.patch. These are source changes only; P1 remains PARTIAL and no validation ran.

### 2026-10-20 08:44 UTC — P6 source audit / P8 resumed

P6 returned PARTIAL after source audit: canonical resource projection, bounded metadata-only SecretBroker refs, offline Doctor, guarded two-setting writes, S1 ownership checks, and strict anonymous free OpenCode defaults are source-present. Credential mutation/live authorization remains unavailable; FEAT-001..014 and integrated TUI/Doctor/S1/free-model journeys remain for later verification. P8 resumed the full phase against P6's policy projection and P3's cache lifecycle. Active owners P1/P3/P8; no validation run.

### 2026-10-20 08:49 UTC — attachment review and active phase ownership

The user explicitly authorized one exact read of the named pasted-text attachment; it has been read once, and root AGENTS.md records that no further outside-repository access is authorized. The note confirms full V1 completion, review/adaptation from actual in-repo OpenCode/Codex sources, a complete architecture/flow/event audit, and implementation before tests. No unresolved design question arose. Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifacts/automation/rewind. P1 source now retains bounded authenticated RepoIntel generations (64 entries / 64 MiB observed-source-byte ceiling only); P3 integration still needs P8's authenticated CacheRegistry lifecycle API. Parent owns P5 and cross-phase audit. No checks/builds/typechecks/audits/provider probes were run. Repo-only boundary active; Git mixed and preserved; V1 PARTIAL / NOT RELEASED.

### 2026-10-20 08:50 UTC — P7 renderer generation fence

P7 fixed an async raster-cache race: results from an older geometry/theme generation can no
longer overwrite the current SVG block frame. A reversed-completion fixture was added to source
but not executed. P7's stream replay/resnapshot, redaction/bounds, artifact fidelity, automation
OwnerLog and checkpoint journal source remains present; no runtime verification is claimed.
P1 is wiring HostKernel automation CRUD/capture/restore adapters. Automation mutation/invocation
must remain unavailable until canonical Guard, one-use lease, supervised effect receipt and
UNKNOWN recovery are complete. Checkpoint preview remains unavailable until authenticated
filesystem and complete VCS facts share one workspace revision; capture/restore remain gated on
Guarded artifact/workspace effects and exact receipt recovery. No validation commands ran.
Repo-only boundary and mixed Git state remain; V1 PARTIAL / NOT RELEASED.

2026-10-20 08:52 UTC — P7 source hardening: the debug analytics formatter now uses a fixed metric/source/unit allowlist and displays malformed or non-safe observations as UNKNOWN without rendering a caller-provided metric label. A regression fixture covers label injection and NaN; it has not been run. P7 effect paths remain closed behind P1 Guard/receipt and checkpoint observation dependencies.

### 2026-10-20 08:53 UTC — source lifecycle recheck and automation ownership

A direct source recheck of local OpenCode TaskTool and Codex spawn/runtime/mailbox/completion code is recorded in §42.12. Horizon may reuse spawn reservation, durable-lineage and startup-cleanup ordering; process-local Codex mailbox/watch and best-effort parent completion are not durable authority. P7 identified the existing automation mutation route: §33.16 operations use common §14.3 `prepare_user_effect` and §14.2 approval, followed by a one-use lease, Rust-owned CAS and durable receipt. P1 owns the HostKernel effect; P7 owns Core/TUI automation flow; P2 owns managed goal/review/run routes. CRUD stays unavailable until integrated; `runNow` and checkpoint effects remain closed until their own execution evidence. P2 also fixed exact-child cancellation after fencing and is closing a VERIFYING crash-recovery gap. No checks were run. V1 PARTIAL / NOT RELEASED; repo-only boundary active.

### 2026-10-20 08:56 UTC — P2 managed settlement recovery source update

P2 now finalizes the exact Rust Run after typed verification and final Guarded Inspect settle its Attempt, before P8 releases capacity. Restart recovery accepts only the authenticated matching terminal snapshot (verified Task, succeeded Attempt, quiesced child, settled effects, exact final workspace revision); it replays `finalize_run` only when that snapshot still has Run phase VERIFYING, then uses the exact existing P8 settlement. It never retries verifier or coding effects. Authenticated cancellation fences Rust first, resolves the active Attempt against the pinned root Session/Location/revision, interrupts only that child Session, and retains CANCELLING until receipt reconciliation. A regression fixture covers the VERIFYING recovery call order; it is not run. P1's trusted verifier adapter and fresh-process UNKNOWN liveness acceptance remain incomplete; P8's exact final-Inspect receipt restart acceptance remains required. Effectful verifier/finalization/dispatch remain unavailable. No validation commands run; V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 09:00 UTC — current parent handoff

Repo-only boundary governs all further work and overrides earlier attachment access authorization. Do not access anything outside agentx; no external service or remote Git operation. Active phase owners: P1, P6 and P7. P2 source handoff is PHASE_PARTIAL: finalization-after-verified-Attempt, recovery from VERIFYING without replaying verifier/effects, and exact child cancellation after the durable cancel fence are in Core; P1 trusted verifier/UNKNOWN proof and P8 final-Inspect restart receipt remain integration blockers. P7 added checkpoint list SDK/TUI projection; automation CRUD uses the existing §14 Guard path, with parent extending only Core supervisor user-action metadata, P1 implementing Rust lease/CAS/receipt/reconciliation, and P7 implementing Core/TUI. P1 has added Guard policy admission for automation actions and retained Core-generated userActionID in HostKernel binding. P5 remains gated: Core knows 11 route IDs but HostKernel currently supports five keyless fixed routes; P6 owns SecretBroker projection and P1 owns authenticated fixed transport. No validation commands ran by explicit implementation-first instruction. Continue source work only; no stage/commit/push/cleanup while Git ownership is mixed.


### 2026-10-20 09:01 UTC — automation receipt ownership correction

P7 has source for guarded Rust AutomationRegistry CRUD and an atomic Guard proof attachment: challenge digest, EffectIntent digest, lease digest, and a post-CAS receipt-core digest computed without self-reference. P1 owns HostKernel's exact binding/one-use lease validation plus EffectHost durable PREPARED/SETTLED control receipt; P7 owns registry integration and Core/TUI. Parent owns the narrow Core supervisor projection exposing server-generated userActionID/capabilityID and optional challengeID/inputDigest; automation calls require authenticated ServerAuth and no Session. The Guard inputDigest is the exact semantic request digest, avoiding a second TypeScript MessagePack encoder. Reconciliation is read-only and never reapplies mutation. P1, P6, P7 remain active; no checks run.

### 2026-10-20 09:11 UTC — active owner and repo-only checkpoint

The repo-only user rule is absolute and has no exceptions. No external path, `/mnt/c`, home-memory service, external service, or Git remote is needed; all reference source is in this repository. Current child owners: P1 Guard/ExecutionHost, P7 streaming/artifacts/automation/rewind, P8 resources/worktrees. P1 has source-integrated guarded automation CRUD/reconcile and matching Core Summary DTOs; invocation remains disabled. P7 is adding TUI actions with explicit unavailable reasons and no mutation dispatch, and owns Core/HTTP/SDK/TUI artifact projections after P1 supplies authenticated bounded HostKernel ArtifactStore read handlers. P8 added resource-limit status projection, RC0 ingestion checks and an in-memory pressure controller; no live ingress until existing Config/HostKernel ownership supplies a typed authenticated policy pin. These are source changes only. Git is mixed and preserved (`main`, 13 commits ahead, one worktree); `kernel/target` is 627 MB. No checks run under the implementation-first hold. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 09:19 UTC — current continuation state

The latest user instruction sets an absolute repo-only boundary: no external filesystem paths,
C: metadata, home-memory services, external services, or remote Git operations. No resource or
source input outside `agentx` is required. The actual active whole-phase owners are P1
Guard/ExecutionHost, P7 streaming/artifacts/automation/rewind, and P8 resources/worktrees/RC0;
all three child slots are occupied.

Parent added the Core side of the authenticated ArtifactStore read seam in
`packages/core/src/session/supervisor.ts`: negotiated `artifact.read-context-v1`, exact
`artifact.v1` operation/body validation, identical ArtifactRef in body and private context,
managed Attempt scope bound to the same Session/Location, and bounded read ranges up to 768 KiB.
P1 confirms the camelCase Rust wire shape and owns HostKernel; P7 owns HTTP/SDK/TUI projection.
Direct Attempt artifact refs remain denied pending durable source-artifact ownership. Routes may
not accept client Attempt scope; they need to resolve it from authenticated managed verification
state. Implementation only: no checks/builds/typechecks/audits/providers were run. Git remains
mixed and unstaged; preserve it. V1 is PARTIAL / NOT RELEASED.

### 2026-10-20 09:21 UTC — P7 source handoff and next owner

P7 returned PHASE_PARTIAL: `packages/opencode/src/session/artifact-control.ts` strictly decodes
managed verifier artifact metadata/ranges, and ArtifactStore independent `read_at` now repeats
authorization, no-follow and digest/ref validation on every range request. Its regression
fixture remains unrun. HTTP/SDK/TUI reads remain unavailable until authenticated managed state
can resolve the exact Attempt scope for a transcript ref; caller-provided scope is prohibited.
The new first-party Core module is now explicitly allowlisted in `.gitignore`. P7 still owns
whole-phase work for checkpoint preview/capture/restore, automation invocation and integrated
stream/TUI journeys. Its slot is assigned to whole-phase P3 RepoIntel/cache. Active owners are
P1/P3/P8. P8's remaining cache dependency is P1's exact HostKernel Arc generation pin-count and
candidate revalidation/retirement API. Source only; no checks were run. V1 remains PARTIAL /
NOT RELEASED.


### 2026-10-20 09:23 UTC — owner queue and dependency checkpoint

P3's whole-phase source audit found no safe work beyond the missing HostKernel generation-pin
and retirement seam; its bounded RepoIntel cache/query behavior remains source-present, while
authenticated cache ingress stays unavailable. P3 is queued to resume when P1/P8 unblock that
seam. P8 has narrowed the unconnected pressure-controller mutation surface to crate-private
until typed authenticated ingress is available. The freed slot is assigned to P2's whole
managed vertical. Active owners are P1/P2/P8. No validation commands ran. Repo-only boundary
and mixed Git state remain; HorizonCode V1 is PARTIAL / NOT RELEASED.

09:24 UTC P5 source correction: a HostKernel-settled successful route whose body is absent or
cannot be safely decoded now surfaces `RESULT_UNAVAILABLE` with its receipt reference, rather
than false cascade exhaustion. This is a completed effect, so the caller can settle the known
receipt and never retry/fall through. An unrun regression fixture covers absent, empty and
malformed result bodies. No tests/builds were executed.

### 2026-10-20 09:27 UTC — managed evidence and worker policy seams

P2 found a source gap in §37.22: durable Rust usage records exist, but the terminal/candidate
managed projection lacks token/cost totals, provenance and UNKNOWN remainder, accounting cursor,
and ceiling digest. P2 owns the exact managed-control summary edit; P1 will bind it into
settlement and P8 may consume only that immutable summary. P1 has agreed to avoid the same
managed-control file during P2's edit.

P1 has specified pre-admission resource projection: Core asks for policy only after Rust has
selected the exact candidate Attempt; HostKernel pins policy revision/digest to that candidate;
`managed.admit_attempt` must present the pins. P8 uses the effective per-Run ActiveWorkers cap
without changing global worker capacity. Old durable entries confer no new policy authority.
Ingress remains unavailable until these source adapters land. Active owners P1/P2/P8; P3 is
queued for P1/P8's generation pin/retirement seam. No validation was run; V1 remains PARTIAL /
NOT RELEASED.

### 2026-10-20 09:32 UTC — P2 terminal accounting summary

P2 added a typed usage summary from durable per-Attempt receipts and bound it into the terminal
snapshot and settlement-candidate digests. The projection exposes accounting cursor, known
subtotals, UNKNOWN/ESTIMATED remainder, aggregate cost/metric provenance, ceiling digest, stop
reason, receipt count and receipt-chain digest. It never interprets a missing receipt ledger as
zero; successful candidate creation requires durable accounting. Core strict candidate and
terminal-recovery decoders now validate and preserve the summary; an unrun regression fixture
contains UNKNOWN token remainder. P1 owns HostKernel candidate/terminal serialization and P8
consumes only the immutable HostKernel terminal proof. No tests/builds/typechecks run. Exact
P1/P8 integration and P2 phase acceptance remain open; effects remain fail-closed.

### 2026-10-20 09:31 UTC — source reuse and continuing implementation

Actual OpenCode TaskTool and Codex child-control source were rechecked from the in-repository
snapshots. HorizonCode adopts their useful lifecycle ordering and bounded projections while
keeping its own Core Session / Rust Attempt authorities; Codex's process-local mailbox and
best-effort completion are explicitly not durable authority. See §42.12 and the direct-child
contracts in §§29/37. Active phase owners: P1, P2 and P8. P2's new terminal usage summary is
source-present and P1 is wiring its HostKernel projection; P8's authenticated per-Run worker
cap is source-present and P1/P8 are integrating its policy pin. P1 continues the whole Guard/
ExecutionHost and HostKernel phase. P5 is still disabled while authenticated SecretBroker
transport is incomplete. The existing in-process `provider-transport.ts` and Auth authorizer
seam are the adaptation target; production authorization is not wired. No validation or live
provider request was run. Repo-only boundary and mixed Git state remain; V1 PARTIAL / NOT
RELEASED.

2026-10-20 09:32 UTC P8 cache follow-up: P8 now requires an exact typed HostKernel retirement
ack bound to its cache candidate/plan before finishing eviction; raw bool-based completion is
private. This is still a source seam without the authenticated Core cache sink/registry caller,
and it makes no reclaimed-byte claim. P1 owns HostKernel retained-generation retirement; P3
remains dependent on authenticated cache ingress. No checks were run.

2026-10-20 09:33 UTC P5 source hardening: `parseSearchProviderResponse` now rejects nested MCP
wrapper decoding beyond four levels, with an unrun regression fixture. This bounds recursive
normalization of untrusted provider payloads; it does not enable search. No checks were run.

2026-10-20 09:34 UTC P1/P8 integration update: HostKernel artifact-read authorization now uses
durable verifier evidence (`attempt_id/source_revision`) because successful settlement clears
`task.active_attempt`. RepoIntel generation retirement returns P8's typed opaque acknowledgement
only after exact candidate principal/workspace, expired leases, and Arc reference-count checks;
no P8 metadata mutation or physical-reclaim claim is made. P3 still lacks its production
authenticated cache sink. No checks were run.

### 2026-10-20 09:35 UTC — P2/P1 terminal usage-summary source integration

P1 HostKernel now serializes the P2 typed usage summary on both the settlement candidate and
terminal recovery projection. The successful Core settlement/recovery decoders require the
exact schema; null remains absent for failed/pre-provider snapshots and is not converted to
zero. Rust verifies receipt ownership, monotonic accounting cursor/totals, stable profile-bound
ceiling, provider/model binding and each receipt digest before computing the bounded receipt
chain; the summary is included in the state digest. P8 consumes only that HostKernel-minted
terminal proof and does not reconstruct totals. No tests/builds/typechecks were run. P2 source
integration is present, but P1 verifier/restart proof, P8 final-Inspect recovery and all managed
vertical acceptance remain open; effects stay fail-closed.

### 2026-10-20 09:36 UTC — P2 Core/TUI accounting completion and remaining gates

P2's remaining independent projection gap is now source-integrated: GoalVerification HTTP output
declares the typed terminal `usageAccounting` DTO, and the TUI rejects a `SUCCEEDED` response
without nonempty accounting evidence/cursor within the managed revision and displays known
subtotals with UNKNOWN/ESTIMATED remainder and cost provenance. The broader P2 source audit found
authenticated review, accepted-SpecVersion start, pinned profile, pause/resume/cancel, current
workspace pinning and recovery flows present. No checks run. P1's authenticated independent
verifier/fresh-process recovery and P8's exact final-Inspect restart receipt remain acceptance
blockers; P2 stays PARTIAL / NOT ACCEPTED and effects remain closed.

2026-10-20 09:35 UTC P1/P2 managed accounting: HostKernel now serializes the exact typed
P2 `usageAccounting` summary in candidate and terminal recovery projections; terminal absence is
null. The DTO names match Core's strict decoder and the existing Attempt state digest binds it;
P8 consumes that digest as part of terminal settlement proof. P2's source review found the seam
aligned. No checks were run; P2 remains PARTIAL pending remaining phase work and integrated
acceptance.

### 2026-10-20 15:12 UTC — active implementation wave

The previous P1/P2/P8 owners terminated at the platform usage limit. Fresh full-phase owners
are active for P1, P2, and P8 with non-overlapping source write scopes: P1 HostKernel/Guard/
ExecutionHost, P2 managed-control/Task delivery, P8 resource/worker/worktree/RC0. Parent continues
P5. P3/P4/P6/P7 remain open and queued for freed slots; P5's fixed route implementation remains
fail-closed pending Guarded transport and SecretBroker prerequisites. P5 response normalization
now limits MCP content blocks to 32 and refuses text wrappers above 128 Ki characters before
JSON parsing. No checks or provider calls ran. All operations remain inside `agentx`; Git's mixed
state is preserved without staging, committing, pushing, or cleanup. Overall status remains
PARTIAL / NOT RELEASED.

15:13 UTC P5 correction: `NEEDS_APPROVAL` is now surfaced as typed `NOT_DISPATCHED`, not as
provider-route exhaustion. This source change does not enable dispatch and has not been tested.

### 2026-10-20 — P2 usage stop enforcement source correction

P2 found `ManagedSnapshot::attempt_usage_stopped` had no call sites: durable STOPPED accounting
receipts did not fence subsequent coding EffectIntent admission. Rust now denies both single
coding-effect and atomic ToolBatch binding after a STOPPED Attempt while preserving the distinct
verification phase. Core's `SessionProcessor` now exits the prompt loop after a STOPPED usage
receipt rather than making another provider request. No tests/builds/typechecks were run per the
implementation-first instruction. P2 remains PARTIAL pending P1 trusted verifier/fresh-process
recovery proof, P8 final-Inspect receipt restart acceptance, and later integrated P2 acceptance.
Repo-only boundary and mixed Git state remain; V1 PARTIAL / NOT RELEASED.

15:14 UTC P2 source correction: STOPPED usage is now an actual effect-dispatch fence in both
Rust single-effect and atomic-batch admission while RunPhase is RUNNING; VERIFYING verifier
work remains allowed. Core records step usage and exits the current stream/prompt loop on the
STOPPED receipt. Source only; no validation was run.

### 2026-10-20 15:17 UTC — P4 active; P8 pressure source seam

P2 returned PARTIAL after enforcing durable STOPPED usage as a managed coding-effect fence and
stopping Core's prompt loop at that receipt. Its remaining verification/recovery acceptance is
dependent on P1 trusted verifier/fresh-process proof and P8 final-Inspect receipt recovery.
P4 is now an active whole-phase owner for LSP/DAP/REPL client lifecycle/protocol modules; P1
retains Rust Guard/HostKernel transport ownership. P8 added a fail-closed PSS-only pressure
consumer requiring exact policy pin, explicit lower watermark/calm count and fresh matching
OwnerLog sample/cursor; it is advisory only and currently has no authenticated product ingress,
configured policy values, or admission effect. P1 is implementing verifier recovery and the
metadata-only Guard-authorized BYO SecretBroker context; P6 will own in-process ProviderTransport
composition when a slot opens. No checks were run. All work remains inside `agentx`; no staging,
commit, push or cleanup occurred.

15:18 UTC SecretBroker binding decision: `arch_V1/12-DOMAIN-SCHEMAS.md` now fixes the V1
`requesterRef` as a domain-separated stable opaque digest of authenticated HostKernel principal,
managed `runRef` as the exact Run, and `profileRef` as a digest of pinned AgentProfileV2 identity,
revision and digest. Direct BYO use requires an authenticated profile pin; missing pins remain
unavailable. P1 owns metadata authorization projection; P6 owns existing in-process transport.

15:19 UTC: P8's source pressure consumer is bounded per owner and resets to empty after restart;
policy/threshold changes invalidate its tracker. It remains advisory, with no durable hysteresis,
HostKernel producer, P6-configured thresholds or P3 admission/cache consumer. P4 has added the
trusted global Config launch-profile resolver and exact Attempt envelope validation; it returns
an approval challenge only, never launch authority. P1 Guard/confinement and P4 service lifecycle
remain gates.
### 2026-10-20 — continuation checkpoint: P4 partial, P6 assigned

The P4 owner returned `PHASE_PARTIAL` with trusted launch-profile projection and protocol
validation source work complete; actual LSP/DAP/REPL processes remain unavailable pending P1
Guarded protocol journal/transport and OS limits, and P3 document-read ingress. P6 now owns the
whole providers/settings/Doctor/S1 phase on its existing source surfaces. Active whole-phase
owners are P1, P6 and P8; P2/P3/P7 remain queued. P5 stays parent-owned and gated. Do not run
validation yet: user directed implementation first. Do not access outside this repository or
publish mixed Git state. Restart by reviewing these phase owners' diffs, continuing P1/P6/P8
implementation, then dispatching P2/P3/P7 as child slots free; keep all effectful routes disabled
until their actual Guard/resource prerequisites are accepted.

15:28 UTC P8 source update: RC0 now reports the actual unsupported operating system instead of
labeling all non-Linux systems as Windows; its regression fixture is present but unrun. P8 cannot
implement the cache caller safely until P1 supplies authenticated HostKernel mint/transport and P3
supplies Core event/generation-release composition. P1 remains active on the metadata-only search
authorization projection needed to resume P6. No tests/builds/typechecks ran. Note that the
active P6/P7 roster is recorded in the later continuation entry below.

15:30 UTC P8 tightened VERIFIED worker settlement: it requires a bounded durable usage chain,
validates optional failed/quarantine summaries, and binds all usage summary fields into the
versioned settlement proof digest. P8 has sent the exact shape to P2 for managed completion
composition. This source is unverified; do not treat the digest-version change as accepted until
the deferred integrated validation stage.

P8 has returned `PHASE_PARTIAL` after its independent source work closed. It remains incomplete
pending P1 authenticated cache mint/RPC, P3 event/callback composition, P1/P2 final-Inspect and
quiescence recovery, OS limits, and RC0 attestation. The freed child slot now has whole-phase P3
RepoIntel ownership. Active phase owners: P1/P3/P7. P2/P6/P8 continuations are queued for a slot
and their exact prerequisites; resume them as soon as interfaces land. No validation ran.

P8 added a bounded inert cache observation receiver with HostKernel-only private provenance,
monotonic sequence/epoch fencing and explicit separation of accounted source bytes from measured
physical allocation. It is not wired because authenticated HostKernel ingress and the P3
caller/eviction callback do not exist. P6 added typed `NoModelsError` when OpenCode or an eligible
free model is missing instead of choosing an arbitrary provider, then returned `PHASE_PARTIAL`.
The released slot is now assigned to whole-phase P7. Active owners are P1, P7 and P8; P2/P3/P6
continuation remain queued. P7 owns stream/artifact/analytics/automation/checkpoint Core/SDK/TUI
surfaces and must keep effects gated on P1. Reassign P6 when P1's metadata signature is stable
and a slot opens. No validation ran.

### 2026-10-20 15:27 UTC — P7 automation UX source update

The TUI automation manager now shows the authenticated request scope, action version/digest,
schedule/timezone, enabled state, overlap/missed-run policy, retry limits, next/current occurrence,
latest recorded result, and `needs_you` when present. Missing data is described as unreported. All
definition mutations and invocation remain unavailable pending integrated P1 Guard/lease/receipt
evidence. Checkpoint capture/restore and artifact HTTP/TUI reads still need P1/trusted managed
scope integration. Source only; no tests/builds/typechecks/audits ran. P7 is still active and the
overall V1 remains PARTIAL / NOT RELEASED.

15:36 UTC P7 returned `PHASE_PARTIAL`; the TUI automation manager's missing §31.12 fields are
now read-only and complete, with invocation/mutations still unavailable. P7's checkpoint
preview/capture/restore waits on P1 trusted workspace/VCS observation and Guarded HostKernel
operations; artifact reads await P1 authenticated handlers and a managed Attempt resolver. The
released slot is assigned to resumed whole-phase P2, which must compose P8's bounded durable usage
summary into managed completion and continue all independent P2 source work. Active owners:
P1/P2/P3. No validation ran.

15:39 UTC P2 now consumes P8's durable usage-accounting summary in managed completion/candidate/
recovery decoding: bounded metrics, nonzero cursor/receipt counts, receipt_count ≤ cursor ≤
managed revision, and full lowercase BLAKE3 ceiling/chain digests are required. Finalization
remains disabled pending P1 verifier/quiescence and P8 settlement recovery proof. P2 continues
source work without validation.

15:41 UTC P1 now rejects all RepoIntel continuation cursors before Location lookup or source
collection; P3 emits lexical partials without cursors until authenticated cursor leases exist. P1
also surfaced a provider-specific P6 contract: fixed Brave uses GET plus `x-subscription-token`,
so P6 must admit only that fixed tuple in ProviderTransport rather than broadening arbitrary method
or header authority. Fresh verifier recovery still cannot establish old-process quiescence, and the
adapter remains disabled. P2 consumes P8's existing canonical usage proof and keeps only the five
metric names emitted by Rust. No checks ran.

15:44 UTC P2/P1 found a cancel race where provider completion can arrive in CANCELLING and its
usage receipt is rejected by a RUNNING-only guard. P2 owns receipt append in CANCELLING; P1 owns
the matching operation-specific HostKernel `record_usage` permission. Coding-effect admission
remains denied throughout cancellation. P1 protocol IO/recovery, verifier quiescence, BYO durable
receipts and authenticated cache mint remain unimplemented and disabled. No validation ran.

P3 source now produces bounded lexical candidate results from immutable HostKernel generations,
with exact UTF-8 byte ranges, file digests, deterministic IDs and honest PARTIAL/parser-unsupported
status. Overlay reads remain unavailable without a trusted editor snapshot; definitions are not
claimed from lexical matches. Core and HostKernel reject unauthenticated cursors before source
collection; pagination awaits P1's authenticated cursor-lease contract. No checks ran.

15:47 UTC P1/P2 completed the source fix for usage arriving after cancellation: only the exact
single revision advance caused by `RequestCancel` is accepted for `record_usage` in CANCELLING;
HostKernel takes the current Rust revision for proof/CAS. Any additional or unrelated stale
change rejects, and coding effects remain RUNNING-only. Integrated source is not verified yet.

15:49 UTC P1 further restricted this exception: equality is permitted only in RUNNING, while
CANCELLING requires exactly one revision difference (the RequestCancel append), denying newly
minted post-cancel scopes. P2 also caps the decoded receipt chain at 4,096 entries. No validation
ran.

15:51 UTC P2/P3/P7 returned PHASE_PARTIAL after their source-only work. P1, P6 and P8 are the
active whole-phase owners: P1 protocol journal/verifier/BYO/cache mint; P6 metadata-only
SecretBroker transport and provider/Settings/Doctor/S1 gaps; P8 cache and settlement recovery.
P2/P3/P7 resume when interfaces land. No tests/builds/typechecks/audits/provider probes ran; all
work remains inside `agentx`, and V1 is PARTIAL / NOT RELEASED.

15:55 UTC P5 adds a release-gated HostKernel authorization RPC seam returning metadata only; it
does not invoke aggregate search dispatch or network. P6 added the strict one-request in-process
SecretBroker ProviderTransport adapter, including only Brave's fixed GET/header profile. It stays
inert until P1 supplies durable per-route intent/dispatch/receipt and the Guarded network sender.
P8's planner now excludes positive owner-reported cache pins and no longer serializes an
unsupported measured-zero value; live Arc pin revalidation remains P1-owned. No checks ran.

15:58 UTC P6 returned PARTIAL with a strict decoder for P1's metadata-only authorization and
one-request local SecretBroker transport; no network sender or cascade path is wired. P1's durable
per-route intent/dispatch/receipt and Guarded sender remain prerequisites. The freed slot resumed
whole-phase P4 to integrate Core LSP/DAP lifecycles against P1's HostKernel protocol journal. P8
now binds worker samples to durable child source revision, excludes pinned caches from planning,
and reports physical allocation UNKNOWN without an authenticated process sample. Active owners:
P1/P4/P8. No checks ran.

P1 resumed integrated source: bounded LSP/DAP framing, strict JSON duplicate-key rejection,
durable HostKernel protocol intent/ACK/event replay journal, and typed LSP callback-reply dispatch
subject are source-present. Callback replies are correlated to an exact retained server-request
event and use the shared outbound sequence/receipt digest. The three typed IO operations remain
constant-false gated before process resolution or bytes pending supervised lifecycle and OS
confinement acceptance. P4 has the exact DTOs and reply digest semantics. BYO search now has a
private durable attempt journal and RPC transitions: PREPARED metadata grant, one-use DISPATCHING
fence, bounded SETTLED receipt, and explicit UNKNOWN; restart maps prepared to ABORTED and
dispatching to UNKNOWN. P6 has the exact strict API and is wiring its SecretBroker transport.
RepoIntel success now mints source-only authenticated cache observations from exact HostKernel
lease/Arc identity, with HostKernel cache planning/retirement accessors and per-Arc pin rechecks;
P8 is integrating. Final-Inspect prepare now resolves Pending or verified Completed candidate state,
while dispatch remains pending-only. Verification remains forbidden during this implementation
wave; no tests/builds/typechecks/audits/provider calls/Git operations were run. Fresh-process
verifier quiescence, cross-phase integration, final gates and release remain open.


## 2026-10-20 15:50 UTC — P1–P8 implementation continuation

The user resumed the full P1–P8 source implementation and asked to defer tests/builds/typechecks/audits until implementation is complete. Active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, and P7 streaming/artifacts/automation/checkpoint. P1–P8 remain the full requested delivery target. P2 and P4 returned source-only partial; P3 is queued for a slot; P5 remains parent-owned. P8 returned source-only partial after P1/P8 integrated more source seams.

Current source deltas: P1 added a durable typed protocol IO/event journal and typed LSP reply subject/receipt, all still release-gated; BYO search route attempts now persist PREPARED/DISPATCHING/settled or UNKNOWN, with restart recovery, and P1 is defining the resumable Rust-owned aggregate step needed to retain one cascade state machine. P1 also mints authenticated RepoIntel cache observations and exposes exact HostKernel retirement composition. P2 fixed `goal.start` so it captures the intended root Session before confirmation, and source review confirms immutable AgentProfileV2 child pins plus authenticated Goal/review/start/control TUI paths. P4 binds protocol requests to direct/managed Attempt scope and composes the authenticated RepoIntel reader without filesystem fallback; process effects remain disabled. P8 binds the full five-key usage summary into final-Inspect candidate v2, adds exact Pending/Completed Inspect receipt recovery, keeps source bytes separate from physical allocation, and binds worker source revision into RC0 schema v3. P6 is composing its fixed SecretBroker sender with P1's durable per-route transitions; P7 is continuing full source work.

Remaining source/dependency items: P1 Guard/ExecutionHost and Linux confinement integration, managed verifier quiescence, final protocol replay/recovery and aggregate BYO pause/resume; P2/P8 managed Inspect/settlement wiring; P3 authenticated pagination/cursor and cache lifecycle, plus parser-backed semantics; P4 P1 protocol/launch gates and OS-enforced REPL quotas; P5/P6 one Rust-owned search cascade with SecretBroker route callback, provider/settings/Doctor/S1 source completion; P7 guarded automation/checkpoint/artifact operations; P8 trusted cache pressure trigger/consumer, RC0 HostRun and independent attestation. Effectful paths remain unavailable wherever Guard, receipt, or OS enforcement is not yet accepted.

No tests, builds, typechecks, audits, provider calls or benchmarks were run. This is source status only; no phase is VERIFIED or RELEASED. The shared mixed Git state is preserved; no staging, commit, push or cleanup was performed.

P1 added `artifact.v1/artifacts.resolve_scope` for transcript continuation. It binds exact
ArtifactRef equality across request and authenticated context, scans only existing managed
OwnerLog heads (bounded; never creates a Goal), and returns a managed scope only for a unique
current-epoch Succeeded Attempt with exact verifier/task/source-revision evidence and matching
ArtifactStore verification-run ownership. P7 has the exact DTO and is wiring its caller. The
search cascade journal now defines strict durable ordered aggregate cursor records, but they are
not yet connected to `execute_search_cascade`; BYO remains unavailable. No validation ran.


## 2026-10-20 16:00 UTC — P5 bounded response projection and P1/P6 search handoff

Parent added a Core-side structural/UTF-8 size bound for HostKernel web-search response bodies before parsing or retaining provider data (20,000 nodes, depth 24, individual strings 2 MiB, aggregate accounted body 4 MiB); malformed cycles, non-finite values and unsupported values are rejected. This is source-only and web search remains gated. P1 is wiring the durable aggregate cursor to BYO attempt authorization/settlement. P6 is composing the fixed SecretBroker sender through HostKernel begin/settle/UNKNOWN transitions, using a strict DISPATCHING permit and a durable SETTLED receipt. P6 confirmed `resultCount:null` is accepted for HTTP success, leaving semantic parsing in Core. P1 has not yet published the aggregate pause/resume DTO. No checks/builds/typechecks/audits/provider probes ran. P1/P6/P7 remain active whole-phase owners; P2/P3/P4/P8 work is queued for available slots. V1 remains PARTIAL / NOT RELEASED; mixed Git state preserved.


## 2026-10-20 16:05 UTC — P6 source handoff; P2 slot refill

P6 returned PARTIAL after its currently independent source work: provider/model availability and truthful free-route selection, requested/effective settings, offline Provider Doctor/API/TUI, S1 owner-chain projection/filter/callback/mixed-effect denial, provider/model switching, and Auth-owned HostKernel begin → fixed SecretBroker request → settle/UNKNOWN with strict permit/receipt matching. It remains integration-blocked on P1's Rust aggregate pause/resume plus parent P5 wiring; network execution stays unavailable. P2 has resumed as whole-phase owner for managed Task/Attempt, authenticated review/verifier, workspace revision, TUI delivery and lifecycle recovery; P1 and P7 continue. P3/P4/P8 remain queued for slots. Parent P5 added bounded HostKernel response projection and awaits P1's exact cascade DTO before Core resume wiring. No verification ran; source only, V1 PARTIAL / NOT RELEASED.


## 2026-10-20 16:10 UTC — P1/P5 cascade continuation boundary; P2 inbox pagination

P1 has now source-wired the initial Rust aggregate pause: after any earlier keyless routes, it durably links the exact one-use BYO authorization attempt to a HostKernel-owned ordered cursor and returns `WAITING_SECRET` with cascadeRef/Digest, route-plan digest/index, next-route authorization, and prior route receipts. P1 is implementing `resume_search_cascade`; Core must validate/forward P6's exact bounded provider response and durable settled receipt, while Rust retains route/retry/fallback authority. Parent P5 now strictly decodes the bounded continuation envelope and rejects orphaned fields, invalid index/digests, terminal prior attempts, and scope transitions; it currently remains gated and does not yet dispatch/resume the secret route. P2 added bounded on-demand Goal-review inbox pagination via the authenticated cursor, keeping each request capped at 64. No checks/builds/typechecks/audits/provider calls ran. P1/P2/P7 active; P6 source handoff partial; P3/P4/P8 queued. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 16:15 UTC — P2/P7 partial handoffs; P4 resumed; P3 queued

P2 returned PARTIAL after on-demand authenticated Goal-review pagination and the prior root-Session-capture fix; its remaining acceptance is blocked on P1 verifier/effect receipts and P8 final Inspect/settlement. P7 returned PARTIAL after artifact HTTP/SDK/TUI reads, renderer/transcript redaction and bounds, stream fences, artifact fidelity and analytics provenance; automation invocation and checkpoint mutation remain unavailable pending P1-owned Guarded operations/observation DTOs. The freed slot resumed whole P4 to integrate LSP/DAP/REPL clients against P1's protocol journal and finish all independently executable source; process/evaluate/REPL effects remain gated by P1 and OS proof. P1 is implementing `resume_search_cascade` using the agreed Core binary body + P6 durable receipt; it is resolving honest EffectHost transport provenance for non-socket SecretBroker sends. P8 resumed cache/worker source; P3 remains queued because the agent thread limit prevented starting another owner. P5 Core now sends only validated WAITING_SECRET routes to Auth, then exact receipt/body to Rust resume; final integration depends on P1 handler and transport-provenance representation. No tests/builds/typechecks/audits/provider probes ran. V1 PARTIAL / NOT RELEASED; shared Git state preserved.


## 2026-10-20 16:20 UTC — P8 cache seam handoff; P3 resumed

P8 returned PARTIAL after adding exact final-Inspect/usage binding and RC0 child-revision source; P8 reports its HostKernel-retained generation observation/retirement composer is present but unconnected at four HostKernel generation-removal callsites. It also added P8 registry invalidation, but no trusted pressure-policy ingress exists, so no cache eviction trigger is enabled. RC0 remains NOT_ATTESTED until P1 live-peer/workspace evidence and P2 independent verifier evidence; OS resource quotas and fan-out remain unavailable. P3 is now resumed as whole-phase RepoIntel owner to connect authenticated generation pagination/cursor and the P1/P8 cache sink using exact current signatures. P4 is active against P1's protocol journal; P1 continues Guard/ExecutionHost and BYO aggregate resume. P5 Core handles the strict WAITING_SECRET→Auth fixed send→Rust resume loop; it is fail-closed and not yet verified. P2/P6/P7 remain PARTIAL/queued for slots. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 16:25 UTC — P5 authenticated BYO continuation wired in Core source

Parent P5 now validates every Rust `WAITING_SECRET` continuation against the exact next approved route before any secret send, calls P6 Auth with the response authorization plus Rust-minted cascadeRef/Digest and authenticated Attempt scope, checks the returned one-use SETTLED receipt against the bounded response, then calls `execution.v1/resume_search_cascade` with the exact receipt metadata and MsgPack binary body. Continuations are bounded by approved route count; Core never retries provider dispatch and reports UNKNOWN when a continuation cannot be reconciled. Strict response parsing rejects malformed/orphaned cursor fields and terminal prior attempts; source regressions were added but not run. P1 has confirmed `secret-broker-fixed-route` is the existing honest EffectHost receipt provenance for this non-socket transport and is implementing the resume RPC plus cancellation support. P3, P4, P1 active; P8 returned PARTIAL; P2/P6/P7 source handoffs remain PARTIAL/queued pending dependencies and slots. No tests/builds/typechecks/audits/probes ran. Search remains gated and V1 PARTIAL / NOT RELEASED.


## 2026-10-20 16:30 UTC — P3 source seam triage; P1 continuation recovery

P3 reports generation pin/query source exists, but Core currently rejects continuation cursors before Location/source read and HostKernel passes no cursor to indexd. No authenticated opaque cursor lease or Core cache notice/retirement RPC projection is published yet; P3 is continuing all independent Core pagination/cancellation/recovery and cache-consumer interface work without inventing production authority, while P1 owns supervisor/HostKernel seams. P1's BYO resume path cannot yet guarantee same-request replay after a lost nonterminal response; parent requested an authenticated read-only continuation resolver that returns the exact next prepared cursor only after a known settled failure, terminal result-unavailable after successful body loss, and UNKNOWN on ambiguity. Secret bodies will not be persisted/replayed. The existing feature remains gated. No checks/builds/typechecks/audits/probes ran.


## 2026-10-20 — implementation-only phase continuation (latest)

**Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P4 LSP/DAP/REPL. P3 is PHASE_PARTIAL, not accepted. P5 is parent-owned; P6/P7/P8 are queued for child capacity. Repo-only boundary is active. User directed that implementation finish before tests/builds/typechecks/audits/provider calls; none ran in this pass.

**P3 source package:** cursor caps and continuation rejection for repeated/no-progress/non-current pages; descriptor-rooted no-follow tree reads with explicit partial coverage; strict textual dependency-manifest decoding. Remaining: P1 authenticated cursor lease and P8's four cache invalidation integrations. Lexical navigation only; semantic definitions and unsaved-buffer overlays stay unavailable.

**P1/P5 cascade:** Rust has a gated continuation replay resolver that returns a prepared metadata-only next route, terminal receipt-only result-unavailable/exhaustion, or UNKNOWN. Core calls it after a lost resume response using exact Attempt and receipt pins and does not redispatch. Parent source review found P1 must fix route-history append to record only the current settled receipt and must make mixed BYO/keyless route ordering safe before release. P1 owns Rust repairs; search remains gated.

**Unfinished P1–P8 map:** P1 Guard/confinement, authenticated cursor/IO/lease/recovery remain active; P2 managed lifecycle and independent final-revision verification active, P1/P8 gated; P3 cursor/cache integration blocked on P1/P8; P4 process effects blocked on P1 and native OS limits; P5/P6 cascade integration and provider/settings acceptance gated on P1/P6; P7 Guarded automation/checkpoint and artifact scopes gated on P1; P8 cache invalidation/settlement integration waits on P1/P2/P3 and OS quota limits. No phase is TESTED, VERIFIED or RELEASED from this pass.


16:35 UTC P5 continuation recovery update: Core now calls `inspect_search_cascade_continuation` after a lost `resume_search_cascade` response, carrying the exact settled receipt and authenticated HostKernel Attempt scope. It accepts only the resolver's Rust-owned next prepared route or receipt-only terminal/UNKNOWN result; it never repeats the provider request. This is source-only and remains behind the release gate. Parent assigned P1 three source-review fixes: append the current settled route (not the first history item), safely handle/reject mixed BYO→keyless order before any post-dispatch uncertainty, and support the documented direct Core Attempt receipt owner.

16:36 UTC P4 reports source for shared execution.v1 LSP/DAP clients with authenticated Attempt pins, bounded replay/correlation, serialized dispatch, Guard lease per outbound operation, quarantine on uncertainty, and strict callback validation. DAP attach/evaluate and all process effects remain unavailable pending Guard/confinement proof; REPL remains unavailable pending P8 OS quotas. P4 continues its whole phase. No checks ran.

P2 whole-phase audit closed a source-level dead end: Run planning accepted up to 64 Tasks although
the implemented independent verifier only accepts a single-Task Run. Core now rejects plans
other than exactly one Task; Rust rejects new multi-Task plans and independently denies start,
scheduler selection and Attempt admission for historical multi-Task Runs, while preserving
OwnerLog replay. The one Task covers the full accepted criteria set. Normative §12.19/§17.18 and
VEO-025 were updated. P2 remains PHASE_PARTIAL pending P1 Guarded verifier/output receipt,
quiescence and fresh-process UNKNOWN integration, P8 final-Inspect/settlement recovery, then
integrated pause/cancel/restart/stale-review/workspace-conflict acceptance. No validation was run.


## 2026-10-20 — P1/P6/P8 continuation; P7 refill; P5 response-loss correction

The requested P1–P8 implementation remains source-only and incomplete. Active owners are P1 Guard/ExecutionHost, P8 resource/worker/cache, and P7 streaming/artifacts/analytics/automation/checkpoint (the completed P6 source pass released its slot to P7); P5 remains parent-owned. P2/P3/P4 have source-only partials and remain in the refill queue for integration after their prerequisites land.

Parent review found and corrected a P5 initial-response recovery defect in `packages/opencode/src/tool/websearch-runtime.ts`: successful exact-pin `inspect_search_cascade` recovery now feeds the existing continuation loop; failed/missing reconciliation still returns UNKNOWN without redispatch. P8 is implementing an independently durable post-settlement worktree disposition transition; Core/P2 settlement projection remains a follow-up. P6 removed the unsafe byte-to-secure-handle export and documented credential put/revoke/live Doctor as unavailable pending protected native input and a Guarded authenticated write contract.

No tests, builds, typechecks, audits, provider calls, benchmarks, or Git publication ran. Feature gates remain closed where Guard, receipts, independent verification, or OS enforcement are incomplete. The shared Git state remains dirty with no staged changes; only the repository tree was inspected. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P1 terminal admission correction; P7 resumed

P1 fixed a source-level shell interpolation denial: user-action and ToolBatch consent projection had assessed residual `no_symlink/no_hardlink`, which are outside Guard's broker-process guarantee set. Those checks now use the exact configured executable/profile, bounded argv/environment, workspace-root confinement, sandbox and one-use dispatch preflight before projecting an empty residual. Denied/no-spawn behavior is unchanged; no test was run.

The released P6 slot is active on whole-phase P7. P7 is closing independent Core/TUI source gaps and recording the remaining Guarded automation and checkpoint operations that depend on absent authenticated HostKernel contracts. P1 and P8 continue their entire phase source work. No tests, builds, typechecks, audits, provider calls, benchmarks, staging, commit, or push were performed.


## 2026-10-20 — P7 analytics correction; P2 phase resumed

P7's independent source review found that the SVG raster port emitted `ui.artifact.raster_cache_entries`, but TUI analytics discarded the entry-count gauge while retaining cache bytes. The aggregation now includes per-renderer entry counts with stale-sample rejection and disposal cleanup; the source fixture and §31.17 status were updated. P7 reports stream replay/fencing, bounded redacted rendering, artifact truth/reads, question event filtering, and analytics allowlisting source-present. Automation invocation and checkpoint/rewind mutations remain unavailable pending P1 Guarded effects and trusted same-revision filesystem/VCS observations. No checks ran.

The freed P7 slot is assigned to resumed whole-phase P2 managed lifecycle/verifier integration; it is continuing Core/TUI source work while P1/P8 dependencies land. P1/P8 remain active. P3/P4 are still queued. All phases are source-only; V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P2 exact dirty-revision settlement projection

P2 now accepts verifier-pinned final Inspect at the exact frozen revision when the observed worktree is `CLEAN` or `DIRTY_OWNED`, while still requiring an owned, no-follow snapshot with no user-owned changes. It rejects contradictory dirty-count/status facts. `DIRTY_OWNED` completion requires P8's durable `WORKTREE_QUARANTINED` disposition; Core's normal settlement and terminal recovery projections preserve that disposition for the TUI. P2 updated §37.22. P8 is implementing the Rust durable disposition receipt and transition; P2 remains PARTIAL pending P1 Guarded verifier/recovery and P8 integration. No validation ran.


## 2026-10-20 — P2 managed source integration audit

P2's resumed source audit confirms the current Core/TUI path derives distinct reviewers from ServerAuth, rejects proposer self-review, fences decisions by exact Spec digest/revision, exposes authenticated Goal proposal/review/plan/start/control actions, and binds the root Session to principal/workspace. Managed Task dispatch carries Rust-projected AgentProfileV2 pins and ManagedAttemptScope into ToolBatch; only one direct or managed Attempt authority is accepted per effect, with refresh limited to HostKernel revision transitions. Restart recovery does not retry ambiguously consumed prompts; cancellation persists the Rust fence before interrupting the exact child. P2 added the DIRTY_OWNED exact-revision settlement/quarantine rule to §12.19/JC-RES-021. These are source facts, not acceptance. Remaining P2 source integration depends on P1 Guarded coding/verifier/final Inspect and durable verifier receipts/replay plus P8 Inspect/settlement and terminal recovery. No validation ran.


## 2026-10-20 — P1 generation invalidation; P2 recovery source reconciled

P1 added cache invalidation before known HostKernel RepoIntel lease/generation drops, using the exact retained cache key/parser-set identity; expiration cleanup uses the same helper. A registry pin/invalidation failure now aborts before dropping the generation. Trusted pressure-trigger wiring remains unresolved and stays unavailable unless the P8 consumer can accept an authenticated sample without claiming unsupported OS limits.

P2 found that §37.22 still listed same-challenge replay and terminal settlement projection as gaps although current source has exact `managed_final_inspect_replays`, fresh-challenge/full-Core-restart receipt resolution, and authenticated `managed.settlement_recovery` from terminal OwnerLog. It documented those source paths as present and superseded the stale gap statement. These remain unverified. P2 continues source integration against P1/P8; no validation ran.


## 2026-10-20 — P8 authenticated pressure and settlement contracts

P8 supplied P1 the exact pressure consumer contract: a HostKernel-minted owner-matched `AuthenticatedResourcePolicyPinV1`, a `sample_owned_resources` snapshot bound to authenticated owner/Core identity, sample sequence/time, OwnerLog cursor and WorkerPool revision, and authenticated owner context. Only measured PSS can produce the bounded hysteresis signal. The signal is advisory only; it does not enforce OS limits, authorize eviction, terminate processes, or release leases. P1 is evaluating/wiring this at authenticated ingress. Cache eviction remains disabled until a trusted trigger and generation-safe callback exist.

P8 says its new durable settlement receipt is exposed through Core/P2 with exact Goal/Run/Task/Attempt/worker IDs, disposition, proof digest, OwnerLog ID/sequence/event digest, worker-pool revision and receipt digest; P2's strict decoder binds those fields. Exact DIRTY_OWNED final Inspect requires `WORKTREE_QUARANTINED`; CLEAN reusability follows P8's full predicate. This is source integration only, not tested.


## 2026-10-20 — P2 phase handoff; P3 RepoIntel resumed

P2's independent source pass is exhausted and returned PHASE_PARTIAL. It also changed the TUI to reject Run plans containing anything other than one coding Task before the API call; Rust remains authoritative. P2 source notes now reconcile the exact `DIRTY_OWNED` final-revision evidence/quarantine rule, P8 receipt fields, and existing replay/terminal settlement recovery paths. No checks ran.

The released slot is assigned to whole-phase P3 RepoIntel (Core/indexd/Tool/TUI), to connect authenticated generation pagination and P8 cache lifecycle where exact contracts exist, and finish all independent tree/detect/document-read/fencing work. P1/P8 remain active; no validation or Git publication was performed.


## 2026-10-20 — P1 raw grep/glob process origin fenced

P1 found that `packages/core/src/ripgrep.ts` executed configured `rg` via raw `AppProcess.spawn`; HorizonCode and OpenCode-derived grep/glob tools reached it without HostKernel Guard/ExecutionHost leases. A false-by-default gate now fails before binary resolution/command construction/spawn until a HostKernel-backed read service is wired. This closes the raw process effect path with honest unavailability; P3 can provide a guarded indexed/read implementation later. No tests ran.


## 2026-10-20 — P8 separate disposition durability and truthful metadata

P8 added source for a disposition OwnerLog round-trip/required-epoch regression (not run) and corrected worktree `has_untracked` projection: nonreusable due to dirty tracked or user-owned content no longer implies untracked files. Quarantined disposition now leaves untracked status unknown; only verified clean reuse records `false`. §21.13 documents independently replayable reservation settlement and worktree disposition, with crash-pending lease ownership retained. P1 owns HostKernel settle/recovery call-site wiring; P8 continues the phase. No validation ran.


## 2026-10-20 — P8 source handoff; P4 resumed

P8 returned PHASE_PARTIAL after implementing its separate durable reservation-settlement/worktree-disposition transitions, exact disposition and pending-state projections, crash-pending quarantine/lease retention, dirty-worktree truthfulness, bounded advisory pressure tracking, and an unrun OwnerLog replay regression. OS-enforced worker limits remain unsupported; RC0 remains release-ineligible without trusted attestations. P1 owns the HostKernel settle/recovery projection wiring; changed-epoch recovery needs fresh authenticated root/Inspect plus P2 terminal proof.

The freed slot is assigned to whole-phase P4 LSP/DAP/REPL continuation, finishing independent Core lifecycle/protocol/profile work while P1 Guard and P8 OS enforcement remain prerequisites for effectful paths. Current active whole-phase owners: P1/P3/P4; P2/P6/P7/P8 are partial and will resume when dependencies/slots permit. No tests, builds, typechecks, audits or Git publication ran.


## 2026-10-20 — RepoIntel cursor and deferred disposition recovery boundaries

P3 identified that authenticated continuation cursors still lack a HostKernel lease DTO/service. P3 is implementing Core client/schema plumbing while keeping page continuation fail-closed; it must not infer or accept a model-supplied generation. P1 now owns the HostKernel lease: mint from authenticated first-page scope and bind principal/Session/Location/epoch/workspace root/generation/revision/canonical query digest/expiry/cancellation; resolve and remeasure read policy before continuation source reads.

P8's separate disposition receipt currently lacks an immutable original owner-epoch accessor. P8 is adding that P8-owned pin/API. P1 will attempt same-epoch `settle_dispatch` recovery only from HostKernel's exact pre-admission epoch; after disposition completion it returns the full settlement receipt. Any epoch/proof mismatch stays pending/conflict; Core never supplies epoch authority or treats it as terminal success. Cross-epoch release requires fresh authenticated Inspect and quiescence proofs. No validation ran.


## 2026-10-20 — P1/P3 recovery and cursor integration source seams

P1 wired same-epoch `settle_dispatch` recovery to query P8's pending disposition, compare P8's immutable settlement owner epoch to the current HostKernel FrameFence epoch, complete only the exact pending disposition, require a durable receipt, then pass through the ordinary strict resolver for `SETTLED`. Missing epoch, mismatch, or unresolved receipt remains UNCERTAIN. It depends on P8 landing the `managed_settlement_owner_epoch_for_attempt` wrapper; no cross-epoch recovery is enabled.

P3 added capability-gated Core cursor lease plumbing: strict token bound, first-page generation pin vs continuation token, no `sourceGeneration` on continuation, and authenticated RepoRead plus interrupt cancellation. Runtime remains unavailable until P1 HostKernel mints/resolves the authenticated lease. P3 is checking existing parser/index integrations for remaining semantic source work. No validation ran.


## 2026-10-20 — P8 immutable settlement epoch pin landed

P8 added `managed_settlement_owner_epoch_for_attempt(attempt_id)` derived from immutable `TrustedPreAdmissionPinsV1.owner_epoch()`. The disposition receipt now carries and digest-binds `owner_epoch`; OwnerLog requires a positive value and replay validates it against exact admission pins. Same-epoch completion also checks `self.resumed_epoch == pinned admission epoch` internally. P1's `settle_dispatch` uses this exact getter before it can complete pending disposition and project SETTLED. No validation ran.


## 2026-10-20 — P4 typed read errors; P2 settlement-receipt consumer resumed

P4 fixed LSP document-open/change to preserve typed RepoIntel stale-revision, oversized and out-of-scope errors instead of collapsing them into generic reader failure; no document text is sent after a read failure. LSP/DAP/REPL process and protocol routes remain hard-disabled until P1 Guarded process IO/confinement and OS acceptance; editor ingress and P3 read-document acceptance remain open. P4 returned PHASE_PARTIAL.

P1 approved adding an exact nested P8 `worktreeDisposition` receipt to ordinary `SETTLED`, with immutable owner epoch, final worktree operation/host receipt, observed revision, Inspect receipt, OwnerLog cursor, pool revision, settlement receipt digest and final receipt digest. The P2 whole-phase owner is resumed to update the strict decoder/TUI projection when P1 lands the Rust shape and continue any remaining source integration. P3 is implementing indexd page advancement (`RepoStructurePositionV1` as a non-authority anchor); P1 is reviewing its exact DTO before HostKernel lease integration. No validation ran.


## 2026-10-20 — P1 approved P3 indexd paging anchor

P1 approved P3's internal RepoIntel paging adapter with an exclusive last-emitted position `{path_ref, symbol_index, byte_offset}`, ordered by BTreeMap path and selector order; `byte_offset` is a UTF-8 byte offset. `next_position` exists only while more matches remain and carries no authority token. HostKernel must resolve the opaque cursor before source reads, remeasure workspace and current Guard read grant, and mint the next opaque lease bound to exact generation/revision/query. P3 is implementing the indexd/Core side; P1 owns HostKernel lease wiring. Feature stays unavailable until both are integrated. No validation ran.


## 2026-10-20 — P1 final P8 disposition receipt wire shape landed

P1's Rust source now includes an exact nested `worktreeDisposition` object in the ordinary top-level `status=SETTLED` response. Fields are `ownerEpoch`, `disposition` (`REUSABLE`/`QUARANTINED`), settlement receipt digest, final worktree operation/host receipt, observed revision, Inspect receipt digest, OwnerLog ID/sequence/event digest, worker-pool revision and final receipt digest; all are string projections from the durable P8 receipt. P2's resumed owner is wiring the strict Core decoder/TUI projection. No tests ran.


## 2026-10-20 — P1 authenticated RepoIntel cursor; P2 disposition consumer; P4 resumed (source only)

P1 added a HostKernel-owned opaque `repo_cur_<64hex>` one-use continuation lease. Its stored
pins bind authenticated principal/Session/Location, FrameFence owner epoch, the original
RepoGeneration lease key, workspace root/revision, source generation, canonical selectors and
limits, P3's internal page position, and expiry. HostKernel resolves the lease before obtaining
a Location snapshot, then rechecks current Guard `files.read`, workspace/revision and query
policy. Consume, cancellation, stale policy/revision, generation retirement and process restart
fence the token. The protocol feature remains false and `hz-kernel` does not advertise it; this
is not enabled or verified. P3 owns Core/indexd pagination, P1 owns the Rust lease.

P2 completed its source-only consumer for P8's nested `worktreeDisposition` receipt: strict
Core decoding, control-plane/SDK shape, TUI preservation/display, and recovery fixture now bind
all exact receipt fields and the outer settlement. P2's remaining managed lifecycle depends on
P1's Guarded verifier/output/quiescence and fresh-process UNKNOWN interface; phase acceptance
was not claimed. Its slot is assigned to whole-phase P4 LSP/DAP/REPL source integration.

Current active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P4 LSP/DAP/REPL. P5
remains parent-owned; P2/P6/P7/P8 are in the refill queue. Implementation-first hold remains:
no tests, builds, typechecks, audits, live provider calls, or benchmarks ran. Existing mixed Git
state is preserved. HorizonCode V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P2 P8 receipt digest binding corrected; P4 implementation continues

Parent's source-only integration review found that the Core P2 decoder equated the P8
worktree-disposition receipt's own domain-separated `receiptDigest` with the logical settlement's
`settlementReceiptDigest`. Rust intentionally computes these as distinct digests. P2 fixed the
decoder and recovery fixture: both digests retain independent BLAKE3 validation, while only
`worktreeDisposition.settlementReceiptDigest` is bound to the outer logical `receiptDigest`.
This correction and its fixture have not been run. The same owner has shifted to whole-phase P4
source work after finishing independent P2 integration. P1/P3/P4 are active; P2 acceptance
remains gated on P1 Guarded verifier/quiescence and final integration. No validation ran.


## 2026-10-20 — P3 bounded-page progress; P4 dependency queue; P6 resumed

P3 found and corrected a pagination liveness defect within the approved exclusive-last-emitted
position contract. When a file suffix exceeds the remaining page byte budget, indexd now records
partial/truncated coverage and continues to later files instead of stopping the page; it mints
`next_position` only after a real extra matching occurrence proves continuation progress. This can
omit occurrences in an over-budget suffix and therefore remains explicitly PARTIAL; it does not
loop or claim complete coverage. RepoIntel remains feature-disabled pending integration acceptance.

P4 reports its independent source pass exhausted: typed LSP/DAP protocol clients and authenticated
RepoIntel document reads are present, but production process lifecycle lacks the P1 Guarded
ExecutionHost prepare/launch/IO/cancel/status API and Core one-use approval adapter. Process, DAP
attach/evaluate and REPL remain unavailable; REPL also lacks supported OS CPU/memory/process/FD
limits. P4 is queued for immediate resume when P1 lands its interface. The released slot is now
assigned to whole-phase P6 Provider/Settings/Doctor/S1 source implementation.

Active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P6 Provider/Settings/Doctor/S1.
P4 is PARTIALLY_BLOCKED on P1; P2 is PARTIALLY_BLOCKED on P1 Guarded verifier/quiescence and
P8 final Inspect/settlement integration; P5 remains parent-owned; P7/P8 await slots/dependencies.
No tests/builds/typechecks/audits/provider calls/benchmarks ran. HorizonCode V1 remains PARTIAL /
NOT RELEASED.


## 2026-10-20 — P3 cursor/tree source wired; semantic/cache gaps retained

P3's source now wires Core cursor schema/call DTO to P1's opaque HostKernel lease, generation
retirement/cancellation removes cursors, and indexd consumes the approved internal position.
The per-page byte-budget overflow path skips over-budget suffixes with truthful partial status
and keeps scanning later files; focused regression source was added but not run. `repo_tree`
has bounded no-follow listing/cancellation and truthful coverage metadata; `repo.detect` and
authenticated `read_document` are source-present. Cursor capability remains disabled pending
acceptance. P3 still lacks parser-backed definition/reference semantics and a trusted immutable
editor-overlay producer; these must remain unavailable unless compatible existing pinned source
and canonical ownership can be established. Cache lifecycle depends on P1/P8 generation hooks.
No checks ran.


## 2026-10-20 — P6 source audit complete; P7 resumed

P6's fresh source audit found no additional safe standalone source change: OpenCode is filtered to
active/free models at default selection, runtime rejects credential-bearing/custom-loader models
before SDK construction, and offline Doctor is authenticated, sanitized and zero-network. P6 remains
PARTIAL / NOT VERIFIED because no acceptance was run; credential put/revoke needs protected native
input plus a Guarded capability, live/full Doctor and catalog action await P1, and search cascade
acceptance depends on P1/P5. No provider calls or validation ran. The freed slot is assigned to
whole-phase P7 streaming/rendering/artifact/analytics/automation/checkpoint source work.


## 2026-10-20 — P1 process lifecycle gate and post-launch cleanup source

P1's source audit confirmed the existing LSP/DAP process path uses HostKernel profile resolution,
Guard challenge/one-use lease, EffectHost durable dispatch/receipt, exact executable/workspace
pins, one StdioExecutionSupervisor, and `horizoncode-sandbox` prepared confinement. P1 added a
false-by-default LSP/DAP lifecycle gate at profile approval, prepare and launch, and attempts
HostProcessRef cancellation if process start succeeds but protocol-journal registration fails.
The Core approval adapter is not yet composed; protocol effect gate remains false and no runtime
acceptance has been run. P4 received the exact launch/protocol DTOs and will resume integration
when its current P7 continuation releases the slot. No checks ran.


## 2026-10-20 — P7 artifact-reference bound; P4 resumed against P1 DTOs

P7 fixed a source-level artifact decoder gap: `ArtifactRef.byteLength` now rejects decimal values
above `u64::MAX`, and §31.18 records the bound. P7 otherwise reports source present for stream
sequence/source-generation fencing, activity route, bounded redacted rendering, analytics,
artifact reads/verified-scope plumbing, Rust automation journal and read-only checkpoint view.
P7 remains PARTIAL because Guarded automation invocation, checkpoint capture/restore and managed
verifier artifact settlement need P1/P2 trusted effects/evidence; integrated UI/reconnect/render/
artifact recovery journeys are deferred to the later verification stage. No checks ran.

P1 has now published the exact HostKernel LSP/DAP launch/protocol DTOs and an off-by-default
editor process lifecycle gate, with post-spawn cancellation on failed journal registration. The
freed P7 slot is assigned to resume P4's Core supervisor/approval adapter and typed lifecycle
integration in P4-owned files. P4's effects remain disabled until acceptance.


## 2026-10-20 — P3 source handoff; P8 resumed on freed slot

P3 returned PARTIAL after source wiring Core/indexd cursor pagination to P1's opaque HostKernel
lease, authenticated tree/detect/document paths, generation invalidation, and partial-over-budget
page progress. Its in-repo pinned-source gap check found no compatible semantic index: OpenCode's
Tree-sitter use is shell parsing/highlighting, and OMP parser dependencies are excluded by §42.11.
Semantic definitions/references and authenticated immutable editor overlays remain unavailable;
cursor feature remains disabled pending acceptance; authenticated pressure-triggered cache
eviction remains unavailable. A focused indexd regression was added but not run.

The released slot is assigned to a fresh whole-phase P8 resource/worker/cache owner to finish the
remaining independent Rust source integration. It must preserve unsupported CPU/memory/process/FD
OS limits as unavailable and keep pressure advisory-only. Active owners: P1, P4 and P8. P6/P7/P3
source passes are PARTIAL; P2/P4/P7 acceptance remains dependent on P1/P8. No checks ran.


## 2026-10-20 — P8 identified shared RepoIntel generation invalidation defect

P8's source review found that P1's HostKernel cache invalidation helper currently retires a
`(principal, workspace, source_generation, build_version)` key on each per-request lease removal,
even when sibling leases still retain that generation. `ensure_repo_generation` can also replace
an identical lease key without explicit old-generation retirement. P1 owns the HostKernel fix: retire
only when the final authenticated lease and Arc owner are gone, and prevent overwrite leaks; P8
provides the retention invariant/API and does not edit P1 files. Cache eviction stays disabled
without trusted pressure policy/callback. This is source review only; no checks ran.


## 2026-10-20 — P1 shared-generation cache retirement race fixed in source

P1 changed HostKernel RepoGeneration lease handling to pin parser-set/build version and file
count; exact-key retry reuses its Arc and refreshes expiry, conflicting replacement fails, and
new leases for the same owner/workspace/source-generation/build-version reuse the shared Arc only
when source revision, Guard policy digest and owner epoch agree. Removing a lease preserves the
shared cache observation while sibling leases exist; final removal requires no active external
Arc owner and successful P8 invalidation, otherwise the lease/Arc remains. Cache observation also
checks current owner epoch and exact parser set. Source-only, not tested.


## 2026-10-20 — P1 extension-origin subworker; P4 lifecycle adapter progress

A bounded P1 subworker is now implementing the plugin/MCP/hook effect-origin closure in its
exclusive Core extension files, while the P1 phase owner remains accountable for Guard and
HostKernel. Existing contracts are used where exact; otherwise effectful dispatch must be gated
false before action. No overlapping Rust/Auth/search/supervisor/TUI edits or validation are allowed.

P4 now exact-decodes Rust launch-profile identity plus consent fields (`inputDigest`, expiry,
targets, normalized targets, policy summary and full approval/residual guarantee assessment),
checks bounded shapes and target equality, and has added a shared-supervisor adapter using the
existing ServerAuth approval Deferred and one-use `resolve_approval` for `language.start` /
`debug.start`. P4 is wiring typed lifecycle RPC calls behind existing false gates. No checks ran.


## 2026-10-20 — Whole-phase source continuation (P1/P2/P4/P7; implementation only)

P1's current source pass confirmed HostKernel terminal/stdio launch is mediated by the retained confined process, Guard one-use lease and durable intent. It is now closing further subprocess origins discovered in Core Git, configured formatters, legacy snapshots, and CLI utility probes; those paths stay unavailable unless exact HostKernel mediation exists. Guarded verifier dispatch remains false because verdict/output recovery is not safely durable after a possible crash.

P2's source pass confirms the authenticated managed review/start, AgentProfileV2-pinned Task scope, per-step usage accounting, cancel fencing, evidence/final Inspect, TUI command mounting and P8 disposition decoder. Its independent source work is exhausted; integrated P2 remains gated on P1 verifier/quiescence/UNKNOWN recovery, P8 final Inspect settlement, and later acceptance. P2 recorded the exact adapted OpenCode/Codex child-lifecycle patterns in the provenance register.

P4 added a Core approval → prepare → launch adapter, typed bounded protocol read/cancel/status decoders, and reconciled the exact P1 consent DTO. It continues with LSP/DAP service installation and policy integration; all effectful process/protocol paths remain disabled pending Guard/confinement and platform proof.

A whole-phase P7 owner is now active on streaming, rendering, artifacts, analytics, automation and checkpoint/rewind source work. Existing P7 effectful automation/checkpoint/artifact settlement paths remain unavailable where authenticated P1/P2 contracts are absent.

P5 source already contains the approved ordered built-in/free and user-enabled route cascade, route controls, auth-failure fallthrough, bounded retry/cooldown provenance, SecretBroker handoff, and HostKernel aggregate/recovery continuation. P5 remains runtime-disabled pending P1/P6 Guarded transport and reconciliation integration. P3/P6/P8 source work is partial; remaining items are the documented semantic-index/editor producer, protected credential workflows/live probes, and trusted pressure/OS enforcement/attestation dependencies.

No tests, builds, typechecks, audits, benchmarks, provider calls, staging, commits, or pushes ran. The implementation-first hold remains. Existing mixed Git state is preserved. HorizonCode V1 P1–P8 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Next: continue P1/P4/P7 source work, refill newly free whole-phase slots for remaining P3/P6/P8 integration, then complete all implementation before the requested verification phase.


## 2026-10-20 — P1 subprocess closure and P4 lost-launch recovery seam

P1's source sweep hard-disabled unmediated Core Git, configured formatter and legacy Snapshot effects; removed pre-kernel spawnSync probes (sysctl, PowerShell, ldd) from the CLI launcher, leaving only the bootstrap process spawn with fixed argv/stdio. No checks ran. Guarded verifier and unsupported process routes remain unavailable.

P4 identified that an accepted editor-process launch whose reply is lost cannot currently recover the HostProcessRef from execution.v1/status; a RUNNING status alone is insufficient to bind protocol IO. P1 owns the Rust status/recovery projection. It must either return the exact original reference with same-epoch and full execution/effect/challenge/location/profile binding, or return typed unavailable and cancel/quarantine. P4 keeps the protocol route disabled and will not fabricate or retry a reference.

P1/P4/P7 are the active whole-phase owners. P2 source pass is PARTIAL and waiting on P1/P8 gates; P3/P6/P8 have source-partial work waiting for phase-owner slots and/or exact dependencies. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication occurred.


P7 found that HostKernel and authenticated Core HTTP already provide Guarded automation create/update/enable/disable, but the TUI automation manager block still labels those controls unavailable and emits no request. P7 now has exclusive writer ownership of only that `packages/tui/src/app.tsx` block and is wiring CRUD through existing Guard approval. Run invocation remains disabled. Checkpoint preview/capture/restore remain blocked because the exact same-boundary filesystem/VCS observation and Guarded effect contract are absent. Source-only; no tests.


## 2026-10-20 — P1/P4 lost-launch recovery source integrated; P3 resumed

P1 implemented P4's lost-launch-ACK recovery seam in HostKernel. Same-epoch authenticated status now returns only the exact HostProcessRef retained for the running process after matching Attempt scope, principal, frame epoch, Location and effect; it includes pinned profile/executable/generation/kind/epoch and resource guarantees. If protocol/ref recovery fails, HostKernel cancels, marks UNKNOWN, durably quarantines and returns typed recovery-unavailable. Restarted/lost bindings are never reconstructed. Source-only, not tested.

P4's source owner returned PARTIAL after adding approval→prepare→launch, bounded status/read/cancel decoders and protocol binding to existing LSP/DAP clients behind caller Guard authorization. Runtime effects remain disabled pending production installation, P1 Guard/confinement, P3 document-read acceptance, DAP policy and REPL OS limits. P3 is resumed as whole-phase owner for RepoIntel Core/indexd/tool/TUI source integration; semantic parser/editor overlay features remain unavailable absent compatible pinned parser and authenticated immutable producer. Active owners: P1, P3, P7. P2/P4/P6/P8 remain PARTIAL awaiting dependencies and later acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git operations ran.


P1 also removed the unused `CrossSpawnSpawner`/`ChildProcessSpawner` imports and dependency from ToolRegistry after confirming no first-party Core/OpenCode consumer remained. This removes an ambient raw Node child-process implementation from the production tool layer; source-only, not tested.


P1 returned a source-only handoff after HostKernel status recovery, launch-kind alignment, and raw-spawner removal. P1 remains PARTIAL because final integrated source coverage/adversarial acceptance has not run and some effect pathways remain disabled pending acceptance; P1 must be resumed for any new safe source gaps after current phase slots free. Its code is present, not verified. P4 has resumed against the new status DTO; P4 status calls must carry the original direct/managed Attempt scope to recover a retained process reference.


## 2026-10-20 — P3 bounded response fixes; P2 resumed

P3 tightened Core continuation validation: a `nextCursor` is accepted only on a current partial page with exactly the requested maximum count and nonempty nodes, matching Rust's extra-occurrence contract. `repo_tree` now enforces a 32 KiB aggregate UTF-8 output limit while reserving room for truncation/partial notices; source regressions were added but not run. §30 is updated. Semantic definitions/references and editor overlays remain unavailable under §42.11 provenance and missing authenticated buffer producer; cursor runtime remains disabled pending integrated acceptance. P3 returned PARTIAL / NOT VERIFIED.

P2 is resumed as whole-phase owner for managed Goal/SpecVersion/Run/Task/Attempt/review/verifier/TUI lifecycle, using the landed P1 same-epoch process status recovery and exact P8 disposition receipt. It must continue independent source work while Guarded verifier/quiescence and P8 final Inspect recovery remain gated. Active owners: P2/P4/P7; P1 requires source follow-up, and P3/P6/P8 remain partial. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran.


P4 now integrates lost-launch status recovery in Core: after a lost launch reply it requests only exact scoped status and accepts a retained same-epoch HostProcessRef; it never retries spawn. New blocker: per-operation LSP/DAP protocol clients require their own Guard authorize callback, but Core `prepareUserEffect` currently admits terminal capabilities only and Rust rejects editor protocol capabilities. P4 will define the Core-side typed adapter and request the exact capability/lease/receipt contract from P1 while leaving protocol activation disabled. No authorization bypass or invented endpoint is permitted; acceptance must cover approve/deny, stale/replay, cancellation and receipts.


## 2026-10-20 — P7 unblocked source complete; P1 resumed

P7 wired the TUI automation manager to the existing authenticated Guarded create/edit/enable/disable and receipt path, plus a bounded exact-field definition editor. The shared approval dialog now offers `allow_once` for only the exact sessionless ServerAuth workspace-owner lane (`user_action` / `authenticated.user_action`, exact CRUD capability, valid HostKernel Location and full assessed consent); it fabricates no Session/Run identity and preserves all existing binding rules. §37.10/§45.15 and §31.20 status were updated. Invocation remains disabled. P7 also fixed stream seal/cursor eviction and source-generation scope, activity byte accounting, raster-generation fencing/fidelity, and analytics allowlists/live cache gauges; unrun regression fixtures were added. Checkpoint capture/restore and managed artifact settlement remain gated by P1/P2 contracts. P7 returned PARTIAL / NOT VERIFIED; no checks ran.

P1 has resumed on the freed slot for the exact P4 per-operation Guard/lease contract, verifier durable output/quiescence, P8 settlement/Inspect wiring, and remaining effect-origin closure. P2 and P4 continue whole-phase source work. No tests/builds/typechecks/audits/provider calls/benchmarks/staging/commit/push occurred.


P4 supplied the exact per-operation protocol Guard contract to P1: HostProcessRef + Session/Location/workspace revision + exact direct/managed Attempt, protocol sequence/method/payload digest and LSP callback correlation; Guard resolves canonical capabilities and returns a one-use lease, with durable pre-write intent and receipt. Exact replay returns the original receipt without another write; conflicts/stale authority reject; cancellation/crash/receipt loss reconcile to receipt or UNKNOWN/quarantine. DAP attach/evaluate remain denied. P4 owns Core consumers and keeps them false-gated; P1 owns Rust Guard/HostKernel admission. This is the source interface request, not yet implemented or verified.


## 2026-10-20 — P4 operation authorization contract; P8 resumed

P4 added the Core-side `EditorProtocolAuthorizationRequestV1` / lease DTO and ServerAuth-only `authorizeEditorProtocolOperation` adapter. It pins exact HostProcessRef, Session/Location/workspace revision, direct/managed Attempt, protocol sequence, method/command and operation/request digest plus LSP callback correlation; it remains fail-closed until Rust publishes matching per-operation Guard admission and durable receipts. P1 is extending the existing prepare_user_effect/Guard path with canonical method-capability binding, lease consumption and receipt journaling. Production LSP/DAP clients remain uninstalled; no operation is enabled. P4's source owner returned PARTIAL / NOT VERIFIED; further source activation depends on P1/P3/OS gates.

The freed slot is assigned to whole-phase P8 resource/worker/cache source continuation, with exact P1 ownership coordination. P8 may not invent pressure thresholds, enable eviction/fan-out, or claim unsupported OS hard limits. P1/P2/P8 source work continues; P2/P6/P7/P4/P3 remain PARTIAL awaiting dependency and acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git operations ran.


## 2026-10-20 — P2/P6 source reconciliation (implementation only)

P2's resumed whole-phase audit found the final-Inspect settlement recovery already source-integrated: Core recovers the authenticated terminal snapshot, finalizes only the exact still-VERIFYING Run, then requests exact P8 settlement; HostKernel resolves the deterministic final-Inspect receipt against the current terminal snapshot/root/claim, with same-owner-epoch pending disposition replay and changed-epoch quarantine. No safe independent P2 source gap remained. P2 remains PARTIAL pending P1 verifier dispatch, durable output/quiescence, fresh-process UNKNOWN reconciliation, and integrated acceptance. The operative plan now reflects source versus acceptance separately.

P6's resumed source audit confirms the existing HorizonCode settings/provider/Doctor/S1 paths and the P6 Auth fixed SecretBroker sender already compose with P1's durable per-route transitions and P5's ordered aggregate continuation: one exact DISPATCHING permit, one fixed route request, durable SETTLED/UNKNOWN receipt, then exact-receipt Rust resume. Runtime search remains off pending P1 aggregate Guard/recovery acceptance. Protected credential writes and live Doctor probes remain unavailable without authenticated Guard authority and protected native input; offline Doctor remains zero-network. FEAT-001..014, S1 and provider/model journeys remain unverified. No P2/P6 code changes or tests/builds/typechecks/audits/provider calls were made in this source pass.


P8 source review found no safe pressure-triggered eviction change: `ResourcePolicyProjection` has no approved lower watermark/calm-window policy, and no authenticated ingress/consumer exists. No values are inferred from soft/hard thresholds. RC0 remains unattested without live P1 HostRun and P2 verifier evidence; OS CPU/memory/process/FD enforcement remains unsupported. P8 hardened its sample timeline so pressure timestamps strictly increase with sequence, added an unrun fixture, and corrected §18.18/cache status. P1 retains exclusive `kernel/src/host_kernel.rs` ownership during its Guard/protocol integration; P8 will not race that shared file. P8 returns PARTIAL pending P1 HostKernel integration, approved pressure policy, OS limits and independent attestation. No checks ran.


## 2026-10-20 — P6 source handoff; active implementation owners P1/P4

P6 returned PARTIAL after confirming current provider/model provenance, free-only model availability, Config controls, offline Provider Doctor, S1 owner-scoped flows and the fixed SecretBroker sender→P1 durable attempt→P5 cascade-resume composition are source-present. No standalone P6 code gap was safe to open without Guard/native consent; live Doctor and credential mutation remain gated, and no checks ran. §16, plan, HANDOFF and CURRENT_RUN are updated.

P8 also returned PARTIAL after strict pressure timestamp ordering; no trusted lower-watermark/calm-window policy exists, so no pressure eviction/fan-out is enabled. P3 and P6 source passes are exhausted. P7 source is complete but awaits P1/P2 gates. P1 is active on protocol-operation Guard/receipts and remaining P1 integration; P4 is active on matching Core lifecycle/protocol consumers; P2 remains queued pending P1 verifier, quiescence and UNKNOWN recovery. P5 remains parent-owned and disabled pending P1/P6 acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran. Implementable source dependencies remain; HorizonCode V1 P1–P8 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 — P1/P2/P4 integration wave active

P1 is implementing the P4 per-operation protocol Guard/lease/durable-receipt path in the existing effects.v2/ExecutionHost boundary, including canonical method→capability checks and same-digest dispatch; no new approval runtime is being introduced. P4 owns the typed Core authorizer/consumer and keeps all protocol routes false-gated. P2 has resumed to consume P1's forthcoming verifier output/quiescence/UNKNOWN DTO and continue managed final-revision verification. Active whole-phase owners: P1/P2/P4. P3/P6/P7/P8 source passes are partial and source-exhausted pending integrated acceptance/dependencies; P5 remains parent-owned and gated. The current runnable dependency chain is P1 Guarded protocol/verifier → P4 LSP/DAP safe wiring and P2 managed verifier; P3 RepoIntel acceptance → P4 document sync; P1/P2 → P7 automation/checkpoint/artifact recovery and P8 RC0. No tests/builds/typechecks/audits/provider probes or Git publication ran.


P1 interface checkpoint (source in progress, 2026-10-20): protocol-operation authorization is being added inside the existing `effects.v2/prepare_user_effect` flow, with strict `ExecutionProtocolAuthorizationV1` arguments, not a new approval endpoint. Guard binds one authenticated direct/managed Attempt, process ref, Session/Location/workspace revision, protocol sequence, typed method/command and operation digest, plus exact retained callback sequence for LSP replies. The ordinary HostKernel challenge → TUI allow/deny → one-use lease is consumed by the existing durable `protocol_op`/`protocol_reply` dispatch journal; replay returns its receipt, ambiguity is UNKNOWN/quarantine. P4 Core is adapting to the proposed DTO. P1 has also begun hardening managed verifier output/evidence recovery; existing managed verifier RPCs remain disabled. These are implementation checkpoints only, not settled wire contracts or acceptance evidence.


Implementation update: P1 will make Rust the sole canonical MessagePack+BLAKE3 producer for `ExecutionProtocolAuthorizationV1.operationDigest`; Core may omit it, and any supplied value must match. HostKernel retains the digest in the Guard challenge and recomputes it at dispatch. P4 is aligning its request/lease DTO and will not hash JSON independently. P2 also added shared strict BLAKE3 validation for managed `challengeSetDigest` across settlement recovery, start/SETTLING, approval resolution and execute result decoding; source-only, not tested.


P1 source clarification: P8's managed final-Inspect path is already present in HostKernel, including exact current revision, candidate-bound approval, guarded git.worktree.list, durable lease/receipt, reconciliation and nested worktree-disposition projection; P2's decoder/settlement consumer is source-present. P2 must not invoke changed-epoch pending-disposition reconciliation as a successful terminal shortcut. Remaining managed verifier gap is process-tree quiescence after abrupt HostKernel death: RunningChild Drop does not kill, stdio handles and process identity are only in memory, so UNKNOWN does not prove descendants are stopped. P1 is investigating the existing sandbox OS process-tree contract; verifier stays disabled unless an OS-owned lifetime/quiescence proof is implemented and later accepted.


## 2026-10-20 — Guarded editor protocol admission source landed

P1 source-landed per-operation LSP/DAP authorization inside existing `effects.v2/prepare_user_effect`. HostKernel strictly decodes `ExecutionProtocolAuthorizationV1`, requires exactly one authenticated direct/managed Attempt, exact same-epoch HostProcessRef/current workspace revision/next journal sequence, derives canonical MessagePack+BLAKE3 operation digest, validates the LSP callback against the exact retained event/request/method, and stores the full canonical DTO in the approved CapabilityBinding. `protocol_op`/`protocol_reply` dispatch now match that retained DTO before durable PREPARED → one-use lease consumption → DISPATCHED receipt; conflicting or stale replay rejects and ambiguous writes fence UNKNOWN. Runtime protocol gate remains false. P4's Core authorizer now sends this exact typed subject and verifies the complete challenge/lease pins before granting the frame lease; P4 is integrating consumers behind false gates. Source-only; no checks ran.

P1's managed verifier remains disabled pending a process-tree quiescence proof and durable typed output/evidence recovery across crash/restart. Plain child kill or UNKNOWN is not sufficient. P1 is evaluating the existing bubblewrap `--die-with-parent` process-tree confinement plus the sandbox guarantee; P2 is preparing the managed verifier consumer against the existing route names while awaiting P1's settled evidence DTO. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication.


P1 source hardening: `horizoncode-sandbox::PreparedExecution::spawn` now arms Linux direct children with `PR_SET_PDEATHSIG(SIGKILL)` and checks the captured HostKernel parent PID immediately after spawn to close the pre-exec race. The confined stdio path already requires ProcessTree=ENFORCED; only bubblewrap currently satisfies that contract, with `--unshare-all`, `--new-session`, and `--die-with-parent` in a fresh PID namespace. P1 updated the guarantee notes, sandbox README and §42 local-source comparison. This is source, not acceptance: verifier/runtime gates remain false until crash/restart quiescence is proven; durable verifier output/evidence is still not recoverable after restart and must remain honest UNKNOWN.


P2 source update: managed verifier artifact-reference decoding now enforces the existing Rust ArtifactStore bounds (≤64 KiB per ref, ≤4 MiB aggregate manifest refs, ≤32 criteria ×64 refs) and preserves BLAKE3 digest validation. Core route callsites already match `begin_verification` → `resolve_verification_approvals` → `execute_verification`, with terminal `settlement_recovery`; no safe adapter can consume the verifier output until P1's durable typed evidence/quiescence DTO lands. P2 remains PARTIAL and is releasing its implementation slot until that DTO is available. No tests ran.


## 2026-10-20 — Managed verifier durable evidence source confirmed; P2 resumed

P1's current source review confirms the verifier already commits exact typed `ObservedVerifierRunV1` plus bounded ArtifactStore refs to managed OwnerLog before returning `SETTLING`. `settle_durable_verifier_evidence` revalidates evidence, current workspace revision, Attempt/profile and receipts; restart recovers the same SETTLING result and refs without rerunning children. Raw output bytes are not durable; a crash before OwnerLog evidence commit remains UNKNOWN/recovery-required, and orphan artifact manifests do not constitute evidence. Exact response binds Goal/Run/Task/Attempt/verificationRun/challengeSetDigest/final+source revision/settlement candidate/evidence digest/artifact refs. P2 is resumed to wire strict Core/TUI decoding and recovery. Verifier stays disabled pending Linux process-tree acceptance and later integration tests.

This supersedes the earlier tracker note that durable verifier output/evidence references were absent: typed verdict/evidence refs are source-present and restart-recoverable after OwnerLog commit; only pre-commit uncertainty remains UNKNOWN. The outstanding security gap is proven OS process-tree quiescence across abrupt kernel death. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran.


P4 source update: Core's editor-protocol authorization lease now retains the exact direct/managed Attempt projection; the LSP/DAP composition comparator normalizes wire BigInt epoch/revision values to canonical decimal strings before exact comparison. §37.6–37.7 now describe composed `prepare_user_effect` → authenticated approval/one-use lease → typed per-operation dispatch and current false gates. Production paths remain unavailable pending P1 Guard/receipt/OS acceptance, P3 authenticated document-read acceptance and production editor ingress; DAP attach/evaluate/variables and REPL remain gated. No checks ran.


P2 source continuation: strict Core managed verifier decoding now binds P1's durable `SETTLING`/OwnerLog recovery projection; verifies exact approved criterion coverage on fresh challenges; requires bounded artifact refs; carries the HostKernel-projected canonical root/workspace ID into verifier approval; and passes bounded UNKNOWN reasons through the HTTP schema and TUI reconciliation text. The HTTP schema also validates BLAKE3 final/source revisions and decimal-u64 OwnerLog revisions. Goal proposal/review/start/control, authenticated distinct reviewer, cancellation fence, exact active-child interruption, terminal recovery and final Inspect/P8 settlement are source-present. P2 remains PARTIAL pending process-tree quiescence acceptance and integrated pause/cancel/restart/UNKNOWN/final-revision conflict acceptance. Verifier and finalization remain disabled while P1 gates are false. No tests/builds/typechecks/audits ran.


## 2026-10-20 — P1 source pass recheck (implementation only)

P1 rechecked the enabled process/effect origins and the existing sandbox lifecycle. `TerminalProcess` and `StdioProcess` prepare through `horizoncode-sandbox` and require enforced filesystem, network, and process-tree guarantees before Guarded dispatch; Linux bubblewrap is the only backend meeting the process-tree requirement. Linux spawn now arms the direct bubblewrap child with `PR_SET_PDEATHSIG(SIGKILL)` plus an immediate parent-PID race check; bubblewrap's existing `--die-with-parent` in its fresh PID namespace fences descendants when the host owner disappears. `RunningChild::kill` remains direct-child-only; ExecutionHost still must observe/reconcile cancellation and cannot treat this mechanism as an exit receipt. Landlock process launches and native non-Linux process effects remain unavailable.

The source scan found the Horizon CLI's fixed-argv bootstrap and Core's trusted HostKernel/SessionSupervisor bootstrap as the remaining first-party process starts outside Guarded product actions. The model shell routes through the `terminal.run` lease and HostKernel; generic Core Bash has no process implementation and fails unavailable. TUI plugin activation returns before plugin imports/initialization or host API grants; the general Plugin service exports no hooks; MCP connect/auth/tool/resource paths return unavailable/empty before transport startup. No hosted provider tool definitions are added to model requests; only local ToolRegistry definitions are passed for execution.

The existing managed verifier response and restart evidence contract is source-present: bounded redacted per-criterion manifests are stored in ArtifactStore, then typed verdicts/evidence refs are committed to the managed OwnerLog before HostKernel returns `SETTLING`. Fresh-process recovery revalidates that OwnerLog evidence against the current workspace revision, Attempt, profile and exact receipts and returns those same refs without rerunning verifier children. A crash before OwnerLog commit remains UNKNOWN/recovery-required; orphan artifacts and output digests cannot establish a verdict. The P8 final Inspect Guarded settlement path is already source-present. No HostKernel source edit was needed in this recheck.

Remaining P1 work is acceptance, not an authorized gate flip: prove Linux abrupt-owner-death process-tree quiescence and explicit cancel/reap behavior; run the integrated adversarial protocol/ToolBatch/verifier restart matrix; verify supported Linux/WSL behavior and keep native Windows unavailable; then reconcile any failures on the final integrated revision. Protocol and verifier gates remain false. No tests, builds, typechecks, audits, provider calls, staging, commits or pushes ran. P1 remains PARTIAL / NOT VERIFIED.

P1 direct-message checkpoint (2026-10-20, source-only): `direct.message.v1/{prepare,commit,inspect}` still re-resolves authenticated ServerAuth, exact direct Attempt/profile/permission/epoch, Location, workspace head and current executing phase. Valid requests now receive the Core adapter's strict typed fail-closed projection: `prepare` returns `DENIED/GUARDED_MAILBOX_UNAVAILABLE` with the canonical pins digest; `commit` and `inspect` return pinned `UNKNOWN` with a deterministic uncertainty marker explicitly not representing an inbox receipt. No lease, append, follow-up turn or success is authorized. The OwnerLog mailbox journal and reuse of EffectHost's persisted Guard challenge/one-use lease remain implementation gaps; keep delivery unavailable until the actual Core inbox append receipt can be durably reconciled. Existing ToolBatch source has bounded 32-call/512 KiB admission, transactional challenge persistence, one-use HostKernel leases, durable effect receipts and UNKNOWN recovery/cancel paths; integrated adversarial acceptance remains pending. No tests/builds/typechecks/audits/provider calls/Git publication ran.

## 2026-10-20 17:55 UTC — source-only handoff checkpoint

- **Active full-phase source owners:** P1 Guard/ExecutionHost; P4 LSP/DAP/REPL; P6 providers/settings/Doctor/S1. P1/P4/P6 coordinate the direct child message/protocol boundaries. P2/P3/P5/P7/P8 remain PARTIAL or gated; P5 is parent-integrated and disabled until its P1/P6 transport is accepted.
- **P1 direct child messages:** HostKernel now contains a durable PREPARED → ADMITTED → COMMITTED journal path, approval/one-use-lease binding, ordered Core receipt digest, committed receipt inspection and UNKNOWN recovery. `kernel/src/direct_message_journal.rs` is now Git-visible. The `direct.message.v1` runtime gate remains false.
- **P6 direct child inbox:** Core has a durable Session-owned inbox, authenticated queue-only message endpoint, idempotent prepare/approval/commit/inspect flow and TUI entry. Safe-boundary FIFO consumption is being completed. Follow-up is UNAVAILABLE until a fresh child Attempt can be minted by the authenticated prompt owner.
- **P4:** resuming Core LSP/DAP/REPL lifecycle and protocol integration against P1's exact typed per-operation Guard contract. Effectful routes remain false-gated; REPL cannot claim unsupported OS resource limits.
- **P8/evaluation:** no further safe runtime change was found without trusted pressure policy, authenticated P1/P2 evidence, live HostRun attestation or OS quota enforcement. `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` §32.40 now defines HUP-001..004 for same-model paired uplift, ablations, benchmark provenance and failure handling.
- **Verification and Git:** implementation-first hold remains. No tests/builds/typechecks/audits/benchmarks/provider calls ran. Git status is broadly mixed, no paths are staged, and no commit/push/cleanup was attempted. All operations stayed inside `agentx`; one worktree, `kernel/target` 627 MB, no project build/test process at checkpoint.
- **Release state:** PARTIAL / NOT VERIFIED / NOT RELEASED. Do not enable direct messages, search, LSP/DAP/REPL, verifier, fan-out, automation execution, or checkpoint restore based only on source presence.

## 2026-10-20 — Latest source roster

- **Active whole-phase owners:** P1 Guard/ExecutionHost, P4 LSP/DAP/REPL, P7 streaming/artifacts/automation/rewind. P2 returned PARTIAL after its independent Core/TUI verifier-recovery source pass; P3/P6 source passes are PARTIAL; P5 is parent-integrated and disabled; P8 is PARTIAL.
- **P6 direct inbox:** safe-boundary prompt consumption and durable immutable ACK proof/preimage are source-present. Lost ACK response does not free capacity or replay input; a fresh live same-authority child Attempt may retry. P1 HostKernel ACK remains unavailable pending integration and acceptance.
- **P3 persistence:** `PersistentGenerationStore` has no production caller. P1 HostKernel needs an authenticated protected root, single owner, and approved bounded multi-scope reuse policy. No aggregate cache budget was found in §30/P8; do not invent one or enable unbounded per-workspace multiplication.
- **P7 CodeMode privacy:** raw nested tool arguments were removed from CodeMode metadata; tests were updated but not run. CodeMode remains hidden from the model-visible registry until Guard/ExecutionHost mediation exists.
- **Verification and Git:** no tests/builds/typechecks/audits/benchmarks/provider calls ran. CodeMode paths are Git-visible but unstaged. Mixed ownership remains; no commit/push/cleanup. Repo-only check: 819 GB free, `kernel/target` 627 MB, one worktree, no project build/test process. Release remains PARTIAL / NOT VERIFIED / NOT RELEASED.

Disk correction: the 819 GB reading is WSL storage. C: via `/mnt/c` has 24 GB free (95% used). An active Cargo test was confirmed to belong to `/home/sarvesh/business_Dev/litecowork`, outside agentx, and left untouched. Do not use WSL free space as a proxy for C:; avoid build-heavy work until C: headroom improves.

## 2026-10-20 — Current implementation checkpoint (source only)

- **Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P3 released its slot after documenting its remaining HostKernel-owned persistent-generation-store dependency. P4 is PARTIAL and awaits P1/P3 integration; P5 is parent-integrated but disabled; P7/P8 remain PARTIAL/gated.
- **P6 direct inbox:** Core safe-boundary consumption now writes immutable original consumption proof and deterministic ACK preimage durably before requesting HostKernel ACK. A lost response holds capacity; retry may use a fresh live same-authority child Attempt without reinjection. P1 validates full fresh `currentConsumer`; immutable proof stays tied to the original consumer and exact consumed message. HostKernel ACK/runtime gate remains unavailable pending P1 integration and acceptance.
- **P3 persistent index:** `PersistentGenerationStore` has no production caller. P1/HostKernel must select and validate a protected authenticated root, own one store per root, and rebuild on corruption; P3 records this in §30 and existing RD-013 acceptance.
- **P2:** whole phase is active again; it must continue Core/TUI managed recovery and source gaps without overlapping P1 HostKernel or P6 inbox/session handler ownership. No effectful finalization or fan-out can be enabled before prerequisites pass.
- **Verification and Git:** implementation-first hold remains. No tests/builds/typechecks/audits/benchmarks/evaluations/provider calls ran. Git remains broadly mixed and unstaged; no commit/push/cleanup attempted. All filesystem work stayed inside `agentx`. Repo-only check: 819 GB free, `kernel/target` 627 MB, one worktree, no project build/test process.
- **Release state:** PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — Benchmark and CodeMode review; current checkpoint

HUP-001..004 already specify paired fixed-model uplift, controlled ablations, benchmark provenance, and honest rate-limit/capability failures. The test catalog now adds HUP-005..006 for fake-provider runner self-check and arm-parity/contamination controls, plus CM-001..007 for CodeMode's future Guarded exposure, nested ToolBatch admission, metadata redaction, bounded execution, cancellation and UNKNOWN recovery. These are requirements only; the implementation-first hold remains in force.

The existing restricted OpenCode-derived CodeMode interpreter is the V1 base. HorizonCode keeps it hidden and nested MCP calls denied until the Rust Guard/ExecutionHost path exists. Current `code-mode.test.ts` contains positive direct-MCP dispatch and plugin-hook assumptions that conflict with the current unconditional fail-closed adapter and must be reconciled in the later verification phase. `repo_take/jcode` has a distinct QuickJS-based CodeMode runtime and a separate `jcode-swarm-core` helper crate; neither replaces the durable Rust Task/Attempt subagent lifecycle. Do not introduce a second interpreter/runtime. Active phase owners are P4, P6 and P8. P2 completed its source review PARTIAL with no further safe code gap; P1 completed a source checkpoint with effects still gated. Its Core Git audit confirmed the AppProcess adapter fails closed before spawn, leaving RepoIntel-facing Git reads unavailable. P4 has added supervised LSP/DAP composition behind false gates. P7 completed unblocked source work; checkpoint restore, automation invocation and graphics transmission remain unavailable. C: via `/mnt/c` has 24 GB free at 95% use; one worktree; `kernel/target` 627 MB. No HorizonCode builds/tests/checks ran; external litecowork process remains untouched. Release is PARTIAL / NOT VERIFIED / NOT RELEASED.
LM-018 was added to §32.11 for the later user-consented free OpenCode provider smoke: exact route, streamed response, bounded coding task, honest 429 and no paid fallback. It is acceptance specification only; no provider call ran.

Latest owner refresh: P3, P6 and P8 are active whole-phase owners. P4 completed source work PARTIAL; supervised LSP/DAP/REPL setup remains unavailable pending P1 Guard/ExecutionHost, P3 reader acceptance, supported OS limits and real-project journeys. P2 completed source review PARTIAL. P1/P7 remain PARTIAL, P5 remains disabled. No checks ran.

## 2026-10-20 18:25 UTC — implementation/evaluation checkpoint

Current whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P3 RepoIntel. P1/P2 resumed; P3 owns Core/indexd schema fixes and the ripgrep caller, coordinating the Guard boundary with P1. P6 and P8 are PARTIAL handoffs: P6 source retains exact same-epoch prepare recovery and queue-only delivery; P8 hardened RC0 limits/ordering with unrun fixtures. Product integration and phase acceptance remain open.

Testing inventory: §32.40 has HUP-001..006 acceptance definitions, but no paired harness-uplift runner or HorizonCode benchmark result is implemented. `scripts/perf/rc0.py` measures operational resource profiles. §32.41 CM-001..007 specifies future CodeMode Guard acceptance. CodeMode remains hidden; its MCP adapter rejects nested dispatch before transport. `repo_take/jcode`'s QuickJS implementation is a separate runtime and is not selected; its bounded-resource/cancellation patterns may inform future changes to the existing interpreter without creating a second runtime. Keep all of these as specifications/source review until implementation closes.

Do not run tests/builds/typechecks/audits/benchmarks/provider calls until the implementation-first hold is lifted. C: `/mnt/c`: 24 GB free; one worktree; `kernel/target` 627 MB. The tree remains mixed/unstaged. Preserve all user work; no staging, commit, push, cleanup, or worktree pruning. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 18:30 UTC — P2/P3/P4 phase refresh

P2 returned a source-only PARTIAL handoff: managed verifier Core/TUI consumers match current Rust evidence/UNKNOWN/revision/artifact/settlement DTOs, with no safe P2-only implementation gap found. Its release dependencies remain P1's guarded verifier and process quiescence/recovery plus P8 final-Inspect/capacity acceptance.

P3 tightened RepoIntel source-response consistency and bounds; new schema fixtures remain unrun. It confirmed ripgrep is blocked before resolution/spawn; it owns Core/indexd callers while P1 owns any Guard contract. P4 is resumed as a whole-phase owner for safe LSP/DAP/REPL source integration, coordinating P1/P3 and keeping effect paths disabled. Active owners are P1/P3/P4. P6 and P8 have partial source handoffs; P5 remains source-present/runtime-disabled; P7 remains dependency-limited. No tests/builds/typechecks/audits/benchmarks/provider calls. Preserve the mixed unstaged tree. C: `/mnt/c` 24 GB free; one worktree; `kernel/target` 627 MB. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 18:37 UTC — phase queue update

P4 returned PARTIAL: source adapters exist, but no safe production ingress can be installed because trusted Session/Location/Attempt context is absent; process/protocol gates stay false. P7 continues and found an artifact-range client bug (offset beyond ref length, and zero-byte nonterminal no-progress cursor); source validation and fixtures are being added, not run. P9 is active on Linux CLI/TUI distribution and release-source gaps; no package build or publication.

§32.12 adds SA-018..020 for parent recovery after interrupted partial writes, restart of queued/running/completed child agents, and provider 429 with explicit-only route change. They are acceptance requirements, not evidence. Active owners: P3/P7/P9. P1/P2/P4/P6/P8 remain PARTIAL or dependency-gated; P5 runtime remains disabled. No checks or provider calls. C: `/mnt/c` has 24 GB free; one worktree; `kernel/target` 627 MB. Preserve the mixed unstaged tree. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — P3/P9 source handoffs; P1/P7 active

P3 completed its unblocked source pass PARTIAL. RepoIntel schema/caller bounds and cross-field consistency are tighter; ripgrep stays unavailable before spawn, and the exact source paths are Git-visible. Parser-backed semantics, unsaved overlays, cache persistence/pressure policy and cursor acceptance remain gated. P9 confirms both product command aliases map to one launcher; it changed only the install documentation URL. Package identity/publication and legal license remain unresolved; it did not touch the shared package manifest or run release commands.

P1 resumed to continue HostKernel Guard/read/cache and origin work against the latest P3 sources. P7 continues its artifact-range bounds fix. Active owners: P1/P7. P2/P4/P6/P8 are PARTIAL/dependency-limited; P5 remains source-present and runtime-disabled. No checks, provider calls, package builds or Git publication. C: `/mnt/c` 24 GB free; one worktree; `kernel/target` 627 MB. Release remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P6 is active again for whole-phase reconciliation of the direct-child inbox against P1's exact prepare/commit/ACK/inspect contract and any safe provider/settings/Doctor/S1 source gaps. P7 added artifact-range no-progress/out-of-range validation and exact checkpoint preview request matching with unrun fixtures. Active owners: P1/P6/P7. P3/P9 returned PARTIAL; P2/P4/P8 remain dependency-limited. No checks or provider calls. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 19:10 UTC — P1/P6/P7/P8 handoffs; P3/P4 resumed (implementation only)

P1 completed its latest source pass PARTIAL. It added a final HostKernel cancellation/deadline fence to RepoIntel responses; guarded document reads, direct-message consume ACK, cache-owner handoff, and pre-spawn ripgrep denial are source-present. A durable OS-level process-tree quiescence proof after abrupt HostKernel death is still missing, so verifier/finalization remain false. P6 reconciled Core inbox prepare/commit/inspect/consume-ACK against the HostKernel pins and found no safe isolated source change; protected credentials/live probes and provider journeys remain gated. P8 found no safe independent source change without trusted pressure-policy ingress, P1 quiescence, supported OS quotas, and HostRun attestation; worker fan-out and cache eviction remain unavailable.

P7 completed its independent source pass PARTIAL: checkpoint action paths now receive strict safe-relative-path, selection, aggregate-byte, regular-file, BLAKE3 and single-link validation in the Core projection, with unrun regression fixtures. Automation invocation and restore remain gated on Guarded dispatch/scheduler and complete same-revision observations. P3 resumed to correct RepoIntel effective-source provenance and inspect remaining safe index/client changes. P4 resumed to resolve safe production LSP/DAP/REPL ingress and lifecycle integration with P1/P3's current contracts.

No tests, builds, typechecks, audits, benchmarks, provider calls, staging, commits, pushes, or cleanup ran. Current active owners: P3 and P4. Git stays mixed/unstaged with one worktree; C: via `/mnt/c` has 23 GB free and `kernel/target` is 627 MB. Work remained inside agentx. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 19:22 UTC — P2/P5/P9 active; benchmark provenance corrected

P3 returned PARTIAL after fixing RepoIntel configuration-source attribution and closing unbounded high-fanout directory enumeration; parser provenance, editor overlays, persistent-cache owner/root, cursor acceptance and Guarded ripgrep remain gated. P4 returned PARTIAL after adding a constant-false REPL authorization gate, invalidating output refs/quarantining callbacks on uncertain outcomes, memoized exact-process cancellation for LSP/DAP failures, and LSP setup cleanup. P7 returned PARTIAL after tightening checkpoint preview action paths to Rust's relative-path, selection, aggregate-size, regular-file, digest and link-count constraints. All new/adjusted fixtures remain unrun. Current active owners are P2, P5 and P9; P1/P3/P4/P6/P7/P8 have source-only PARTIAL handoffs.

The benchmark note in §32.40 now distinguishes NVIDIA's Nemotron report values (SWE-bench Verified 70.7% BF16 / 69.5% NVFP4; Terminal-Bench 2.1 56.4 / 53.9) from the user's older estimates; separates Opus 4.5's 80.60% thinking and 80.90% no-thinking configurations; and notes FeatureBench's displayed Lite results are Dataset V1.0 with separate `passed`/`resolved` scores, not comparable directly to Nemotron or a generic 11% claim. HUP-001..006 remain evaluation contracts only; there is no HorizonCode uplift runner or score. CodeMode is intentionally absent from the registry even if experimental flags are set; direct nested MCP dispatch fails before transport. The legacy large CodeMode unit file still contains positive dispatch expectations and must be reconciled before the verification wave.

No tests, builds, typechecks, audits, benchmarks, provider calls, release commands, staging, commits, pushes or cleanup ran. Git remains mixed/unstaged with one worktree. C: via `/mnt/c` has 23 GB free; `kernel/target` is 627 MB. Work stays inside agentx. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 19:28 UTC — P2 source handoff; P5/P6/P9 active

P2 completed a whole-phase Core/TUI source recheck PARTIAL with no correction: managed verifier SETTLING/UNKNOWN and final-revision decoders match HostKernel; artifact preview resolves exact managed scope through HostKernel; P8 settlement projections match. Managed verifier/finalization/fan-out remain unavailable pending P1 process-tree quiescence and P8 acceptance. P5 found a Settings truth gap: BYO routes are hardcoded as “unconfigured” and UI has no per-route inspect status despite `WebSearchRuntime.inspect` already exposing sanitized local `configured/available/status`; P5 is adding a read-only authenticated settings projection using the existing runtime, without network calls or secret bytes. P6 is active on trusted SecretBroker credential input and remaining provider/Doctor/S1 source work, keeping credential mutation and live probes disabled absent accepted protected input. P9 is adapting release-tool temporary paths to an ignored repo-local artifact subtree and correcting native Windows support claims; no package/legal/signing policy is being invented.

Benchmark evidence in §32.40 now distinguishes the current cited NVIDIA Nemotron and Anthropic Opus configurations, FeatureBench V1.0 leaderboard score fields from V1.1 dataset release, and the 7.7-point Meta-Harness classification result from its TerminalBench-2 coding experiment. Added paired task/repository-group uncertainty guidance and clarified that FeatureBench's CPU gold-patch scoring timing is not HorizonCode inference time. These are reference corrections and acceptance requirements only; no runner or uplift evidence exists.

No tests/builds/typechecks/audits/benchmarks/provider calls/release commands/Git publication/cleanup ran. Active whole-phase owners: P5/P6/P9. Git remains mixed and unstaged with one worktree; C: via `/mnt/c` has 23 GB free and `kernel/target` is 627 MB. Work stays inside agentx. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 20:04 UTC — P5/P6 source handoff; P1/P7/P9 active

P5 returned PARTIAL after adding authenticated read-only `GET /websearch/providers`, strict credential-free status schema, SDK method, and TUI Settings projection. No provider probe/network call occurs; search dispatch remains disabled. P6 returned PARTIAL after adding owner-checked QuestionV2 list/reply/reject handlers and SSE filtering for both active and V2 question event names, with workspace/directory/cycle/depth fencing and QA-006/007. Protected credential input and live Doctor remain disabled.

Whole-phase P1 Guard/ExecutionHost and P7 streaming/artifacts/automation/rewind owners are active, as is P9 Linux/WSL release source. P2/P3/P4/P8 remain PARTIAL/dependency-limited. Exact `.gitignore` entries expose P5 API/schema files and P9 operator guide. No tests/builds/typechecks/audits/benchmarks/provider calls/release commands ran. Preserve the mixed unstaged tree; one worktree; C: via `/mnt/c` has 23 GB free and `kernel/target` is 627 MB. Work stays inside agentx; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 20:08 UTC — P9 handoff; P1/P4/P7 active

P9 returned PARTIAL: Linux/WSL local-candidate install and shared `horizoncode`/`hzcode` launch paths are source-present; native Windows and unsigned remote installation are disabled; release artifacts moved under ignored repo-local `kernel/target/horizoncode-release`; unsupported upgrade flags were removed. License/notices, package naming, signing/update/rollback policy and exact-candidate Linux+separate-WSL qualification remain. P1, P4 and P7 whole-phase owners are active. P5/P6 returned PARTIAL; P2/P3/P8 remain PARTIAL/dependency-limited. No checks, release operations or Git publication ran.


## 2026-10-21 06:33 UTC — resume manifest

- P1: active whole-phase Guard/ExecutionHost source work; critical dependency for managed turn scope, Guarded effects and process quiescence.
- P2: PARTIAL; follow-up/serialized child turn remains unavailable until P1's typed HostKernel scope DTO and one-use authorization exist. Do not invent the wire shape.
- P8: active whole-phase resource/worker/RC0 plus fake-only evaluation-runner work. Fix summary fixture signature, preserve unsupported-capability rows through journal recovery, and harden append-only artifact path against symlink/replace races.
- P9: active release-source work. Use no-follow/exclusive creation for report/marker/manifest paths after validation; no builds or release commands.
- Verification hold: no tests, builds, typechecks, audits, benchmark/provider calls, or release commands until implementation is complete. Preserve mixed Git state; no staging/publication or cleanup.

Evaluation assets: §32.40 HUP-001..008 and §32.41 CM-001..009 are acceptance plans. `scripts/eval/eval_harness.py` is a fake-only self-check, not a real benchmark runner. The user's Nemotron/Claude score table is not apples-to-apples; use exact pinned benchmark release, split, evaluator, model, route, image, harness, and budgets. Later order: fake self-check; explicitly selected free-provider route smoke; small FeatureBench/SWE-bench Lite/Terminal-Bench development samples; then frozen paired holdout and ablations. Never label smoke or self-check as an official score.


## 2026-10-21 06:38 UTC — owner refresh after reference audit

Read the user-authorized single attachment `pasted-text-1.txt`; it reiterates whole-V1 delivery, source-first OpenCode/Codex comparison, future-design explanation, complete architecture/flow/event audit, documentation updates, implementation before tests, and an explicit ask to raise any unresolved design decisions promptly. No additional external path/service/remote access occurred. Actual in-repo Codex handlers confirm distinct spawn, queue-only send, trigger-turn follow-up, list, bounded wait, interrupt, parent/root-turn correlation and activity projection; OpenCode TaskTool confirms role resolution, depth bounds, parent-intersected permissions, child Session creation, and explicit background completion injection. HorizonCode adapts these under §29/§37 profile pins, Rust Guard/HostKernel and durable delivery; it does not inherit their ambient authority.

P1/P2/P9 are active whole-phase owners; P8 returned PARTIAL after source-only fake HUP-005 runner work. P1 confirmed §37.9's exact `direct-turn-v1` schema/Rust DTOs exist and is implementing the HostKernel dispatcher/journal; P2 resumed for Core/TUI integration against that exact contract. P8 evaluation artifacts are append-only/fsynced JSONL with no-follow descriptor traversal and paired uncertainty summary; fixtures remain unrun, and worker/resource/RC0 work remains blocked on P1/P2 contracts and an approved pressure policy. P9 added exclusive no-follow artifact writing; remaining P9 decisions/gates are still open. No tests/builds/typechecks/audits/benchmarks/provider calls/release commands ran. Git remains mixed/unstaged; no publication or cleanup. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:41 UTC — active owners and direct-turn boundary

**Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, P5 built-in web-search cascade. P9 returned PARTIAL after source hardening; P5 now owns the freed slot. P3/P4/P6/P7/P8 remain PARTIAL or dependency-limited and will be resumed in critical-path order as slots free. Preserve the mixed Git state; no staging, commit, push, cleanup, validation commands or provider traffic occurred. Work remains inside the repository under the current repo-only boundary.

**Direct child follow-up blocker:** P2's source audit established that `TaskTool.childRun()` currently settles the DirectAttempt after one `ops.prompt`, while HostKernel's §37.9 fresh-turn issuer requires the same live EXECUTING Attempt and the next turn on that Attempt. Core also needs a fresh authorization proof in the durable inbox/prepare path and a wake/turn trigger through the existing Core owner. Keep `follow_up` and non-initial effectful turns unavailable until this lifecycle and authorization path are integrated. P1/P2 are coordinating against the normative owner.

**Turn-scope design question:** Current `DirectTurnScopeV1` digests the full mutable Attempt snapshot; a Guarded effect can advance its revision/workspace state during the turn. P1 proposed stable cycle identity/profile/permission/epoch pins, with each effect carrying a current refreshed Attempt scope checked by HostKernel. The alternative is refreshing a complete turn scope after each effect. This was asked to the user; do not change the contract or enable dependent effect dispatch before the answer. P1 continues independent Guard/HostKernel work.

**P5:** implement the whole approved V1 cascade and read-only Settings status/provenance, preserve consent/order/auth/cost/freshness and bounded retry/failure reporting, add unrun acceptance fixtures, and update P5's normative topic/test catalog. Auth 401/403/407 falls through; other non-rate-limit 4xx stops; no hidden paid fallback. P9's remaining release decisions and acceptance evidence are in `scripts/release/README.md`. Implementation-first hold continues; HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:43 UTC — new direct-turn source progress

P1's durable turn journal now pins the HostKernel process incarnation at cycle and fresh-proof issue/reserve boundaries. Same-epoch active cycles from a prior process, unresolved prior-process proofs, and consumed proofs lacking the exact next cycle replay as UNKNOWN. Completion receipt replay uses the canonical OwnerLog cursor digest. This improves source recovery fencing but is not crash/restart acceptance evidence. P2 added strict Core RPC adapters for begin/complete/issue-fresh-turn, validating exact response shapes and authority pins; the TaskTool/sessionRunner caller, same-Attempt lifetime, follow-up wake trigger and turn-bound effect envelope remain unfinished. No tests/builds/typechecks were run.

## 2026-10-21 06:45 UTC — current phase owners

**Active:** P1 Guard/ExecutionHost; P6 providers/settings/Doctor/S1; P7 streaming/artifacts/automation/rewind. Slots are full (three child agents). **Partial handoffs:** P2 has strict false-gated direct-turn RPC adapters but no TaskTool/sessionRunner lifecycle; managed dispatch/verifier still depend on P1/P8. P5 has source-complete cascade and authenticated offline status/TUI controls, but dispatch stays disabled pending P1 Guard and P6 SecretBroker acceptance. P3/P4/P8 are queued or dependency-limited; P9 is source-partial with release decisions/acceptance open. Refill a slot immediately on owner handoff, in critical-path order.

No tests, builds, typechecks, audits, benchmarks, provider calls, release commands, Git staging/commit/push, or cleanup were run. Preserve all mixed/untracked paths. The user’s direct-turn digest decision is still pending; no dependent effect authority changed. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:47 UTC — benchmark and CodeMode source findings

The evaluation foundation is not yet a live benchmark runner: `scripts/eval/eval_harness.py` only supports deterministic fake HUP-005 self-check. The test catalog already contains HUP-001..008 (paired comparison, ablations, provenance, failure handling, parity, attribution and optional matched OpenCode/Codex arm) and CM-001..009 (CodeMode exposure, authority, atomic batch, privacy, recovery, interpreter bounds and memory limitations). The tested implementation sequence remains fake runner self-check → one explicitly selected free-model response and bounded coding smoke → pinned small benchmark development samples → frozen paired holdout/ablations. No test/provider call was run.

`repo_take/oh-my-pi/packages/metaharness` supplies manager patterns (experiment/run/task/trace, normalized costs, task-arm matrix, resume completed trials); it also includes execution pathways with containers, provider gateway and paid routing that are not approved for reuse. HorizonCode already has a local JSONL fake runner. CodeMode is a bounded-language interpreter over explicitly supplied tools, not an agent loop. HorizonCode keeps `execute` hidden and every nested MCP call currently fails before the MCP client; wrapper construction has no explicit timeout/call/output limits and no hard memory ceiling. CM-008/009 directly capture those limits. Interpreter tests alone cannot satisfy Guard/ExecutionHost acceptance.

P6's current source status: model picker accurately marks dispatch unverified and shows unknown context/input/output limits; SecretBroker credential writes/live Doctor remain fail-closed pending P1. P7's source status: bounded stream/render, redaction, artifact/analytics, automation CRUD and checkpoint preview/recovery projection exist; effectful run-now and checkpoint create/restore remain unavailable. Schedule syntax, timezone DB revision, DST and clock-jump policy are unspecified, so scheduled invocation remains disabled. Active whole-phase owners: P1/P6/P7. Source observations are not test evidence. Continue preserving mixed Git state; no publication or cleanup.

## 2026-10-21 06:48 UTC — P3 generation-build coalescing boundary

P3 found `HostKernel::ensure_repo_generation` does not coalesce identical concurrent in-flight index builds; it deduplicates only after work is done. P1 owns HostKernel and accepted this as a P1 shared-boundary source fix. P3 continues independent files; do not introduce a second index owner. P7 may now add two exact `.gitignore` exceptions for its transcript source/test after P1 confirmed no further edits to that file. No tests or builds have run.

## 2026-10-21 06:49 UTC — P7 source handoff and P8 activation

P7 returned SOURCE PARTIAL. Bounded transcript formatting/truncation, UI-018 fixture source and exact ignore exceptions are present; no tests ran. Scheduler invocation remains closed until cron grammar, timezone database revision, DST overlap/gap and clock-jump behavior are specified and guarded. Checkpoint capture/restore remains closed pending complete same-revision VCS facts and P1 Guard/receipt. Terminal graphics remain unavailable; text fallback. P8 resumed as the whole resource/worker/RC0/evaluation owner. Active owners P1/P3/P8; all reports remain source-only.

## 2026-10-21 06:50 UTC — precise RepoIntel reuse and artifact-search status

P1's retained-generation lookup is now source-present before `build_repo_generation`. The same HostKernel request loop synchronously dispatches one `&mut HostKernel` request at a time, so queued calls cannot overlap inside one HostKernel; however source collection still runs before the lookup, and current reuse requires same Session. Do not claim full §30.22 coalescing/work reduction until the exact base-pin and owner-lease semantics are reconciled. P3 owns the managed artifact-search tool through authenticated Session ArtifactControl and HostKernel range reads; it must have no path/filesystem fallback and preserve read authorization. No tests/builds ran.

## 2026-10-21 — Current continuation handoff

Resume the complete V1 P1–P9 implementation, not a narrow slice. Do not run validation yet: the user explicitly wants implementation completed first. Do not access paths/services/remotes outside this repository, stage/commit/push, or clean/prune.

The DirectTurnScope decision is resolved in §37.9: keep the full-snapshot scope and digest; after a settled effect or fully reconciled batch, HostKernel returns a refreshed scope with the same cycle ID and turn sequence, Core persists it before another effect/completion, and UNKNOWN/unresolvable refresh fences the cycle. P1 owns HostKernel integration; P2 owns Core caller/lifecycle integration.

Active owners: P1 Guard/ExecutionHost, P3 RepoIntel/artifact-search, P8 resources/workers/RC0. All child slots are occupied; resume P2 as soon as one is free. TaskTool source now resolves versioned Core `AgentProfileV2`; remaining P2 includes persistent same-Attempt lifecycle, turn RPC/fresh-proof safe-boundary trigger, managed end-to-end recovery and TUI integration. P3's artifact search must use authenticated ArtifactControl scope and HostKernel digest-pinned ranges, with no filesystem fallback. Keep dependent effects disabled until P1 prerequisites are accepted. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P3 boundary update: `repo_tree` and `repo_detect` have been removed from model-visible registry exposure because they use app-process `RepoIntel.nodeSource`. Keep their canonical capability IDs but report them UNAVAILABLE until P1 supplies a bounded authenticated HostKernel discovery/manifest operation and P3 wires the Core adapter. Managed artifact search is registry-wired to ArtifactControl and HostKernel digest-pinned ranges; its source is now Git-visible. No tests/builds run.

P3 has released its slot PARTIAL: managed artifact/text/terminal range search is registry-wired through ArtifactControl and digest-pinned HostKernel reads; repo_tree/repo_detect are unavailable pending P1 HostKernel discovery/manifest + P3 Core adapter. Other P3 blockers include authenticated cache pressure/retirement, approved parser, unsaved-buffer producer, P1/P4 supervised LSP, and direct-session artifact ownership. P2 has resumed whole-phase work; active owners are P1/P2/P8. P1's direct-turn batch journal/schema is present but effect admission/receipt integration remains in progress; P2 must wait for exact P1 DTO before Core caller wiring and keep gates false. RC0 remains NOT_ATTESTED pending P1 process ownership and P2 final verifier receipt. No test/build/provider/release/Git publication or cleanup; P3 did run `git diff --check` once with no diagnostics.

P8 interim: HUP paired summaries now account for all invoked calls, incomplete pairs and per-arm failures; fixture costs are truthfully `FIXTURE_REPORTED`. Durable worker replay is source-present and conservative; settlement remains dependent on P1 quiescence/Guard and P2 terminal Attempt/final revision evidence. RC0 remains NOT_ATTESTED. No tests/builds/evaluation ran.

P8 released its slot PARTIAL after independent HUP reporting and RC0-output source hardening. RC0 remains NOT_ATTESTED; worker settlement waits on P1/P2 proofs; CPU/memory/FD enforcement and trusted pressure ingress remain unsupported. P7 has resumed for its whole streaming/artifact/automation/rewind phase. Active owners P1/P2/P7. No tests/builds/evaluation run; P8/P3 each ran `git diff --check` on owned paths with no diagnostics. No publication or cleanup.

P2 interim: strict direct-turn batch scope validation and persist-before-dispatch source is present in Core `managed-control.ts`/`session/tool-batch.ts`. Still to wire supervisor request/approval/final receipt decoding, LLM/prompt/TaskTool propagation, completion/follow-up wake and managed recovery. P1's final HostKernel refreshed-scope response shape is the current dependency. No tests run.

P7 interim: authenticated per-instance SSE fanout is now bounded to 256 queued events and 64 KiB per serialized event, filters unrelated workspace/location before enqueue, and fails closed on overflow to force reconnect/resnapshot. See §31.17. No tests/builds ran.

P7 source handoff PARTIAL: bounded authenticated SSE admission is implemented, but transient non-Session projections lack replay/list APIs; checkpoint/restore await P1 Guard plus exact same-revision HostKernel facts; automation invocation awaits canonical timezone/DST/clock policy and Guarded dispatch; terminal graphics remain text fallback. P4 resumed whole-phase LSP/DAP/REPL integration. Active owners P1/P2/P4. Keep all dependent effectful gates closed pending P1 acceptance. No tests/builds run.

P2 now has strict Core DirectTurnScope decoders; it is wiring Prompt → LLM → ToolBatch authority and post-bind scope persistence. Write/patch receipt refresh and Task child persistence remain; follow-up stays gated until P1/P8 proof.

P4 direct-session lane decision: support an explicit DirectTurnScope authority lane for ordinary authenticated direct Sessions, alongside managed/child Attempt lanes; never rely on Session ID alone. Keep unavailable until P1 supplies matching HostKernel process/Guard/protocol authority and acceptance.

Correction: `DirectTurnScopeV1` is child DirectAttempt authority only, not a root direct-Session scope. P4 will support the managed and Goal-less child lanes; root-session editor processes remain unavailable pending a canonical P1 HostKernel root-session effect/process authority contract. AgentProfile and ExecutionLaunchProfile IDs/revisions/digests are independent pins.

P1 located an existing authenticated bounded HostKernel `query_structure` projection which may enable P3 repo_tree/repo_detect adapters without new Rust DTOs. Reopen P3 against that exact RepoStructureQuery/Page contract when a slot opens; keep registry routes unavailable until semantics/acceptance are implemented.

P4 corrected the AgentProfileV2 vs ExecutionLaunchProfile pin conflation in LSP/DAP/REPL validators. Root direct-session editor authority remains absent; only child DirectTurnScope and managed lanes are in current contract, both gated on P1 process/Guard/receipt integration, P3 document-read acceptance and OS confinement. DAP attach/evaluate/variables remain denied; P4 continues output receipt fidelity source work. No checks ran.

P4 source handoff PARTIAL: profile pins are now separated; editor output requires exact process ref and settled durable receipt. Remaining P4 requires P1 Guard/editor wire and OS confinement, P3 read_document acceptance, production ingress, DAP/REPL recovery and real Linux journeys. Root direct-session scope remains unavailable. P6 resumed whole-phase ownership; active owners P1/P2/P6. No validation/provider call run.

P2 now persists child DirectTurnAuthority through turn begin, batch bind and final write/patch/terminal receipt; Core PTY/shell carries scope through terminal.run and validates final-turn receipt/replay. TaskTool same-Attempt lifecycle, follow-up wake and managed recovery remain. P1 HostKernel batch admission is source-wired; P1 is fixing exact receipt replay across multiple batches. No tests run.

P1/P2 source progress: HostKernel validates and journals direct ToolBatch cycle scope, returns refreshed scopes after bind/final settlement, and retains exact replay receipts across later batches. Core carries scope through TaskPrompt→LLM→ToolBatch, write/patch and terminal.run. Runtime turn begin remains disabled because TaskTool still settles per prompt and has no same-live-Attempt continuation/fresh-proof recovery. No tests.

P6 is fail-closing legacy HTTP OAuth authorize/callback mutation handlers before service invocation; offline Doctor missing freshness is corrected to UNKNOWN. No live provider/test activity.

P2 needs HostKernel-authenticated current DirectAttemptScope/workspace pins to resume an EXECUTING child after restart; `direct_attempt_snapshot` summary and persisted TaskTool metadata are not authority. P1 is asked for a fail-closed live-scope recovery operation; follow-up proof remains gated.

P6 source: offline Doctor now preserves UNKNOWN for absent-model freshness; legacy HTTP provider OAuth mutation routes return typed 503 before ProviderAuth and OpenAPI records the protected-input/Guard prerequisite. P6's remaining dependencies are P1 protected credential/probe grants and trusted Session-root owner stamping for S1; no tests/providers run.

RepoIntel cache fact correction: HostKernel cache reuse excludes request/Session from immutable generation matching and supports same-principal Sessions only when all source/root/policy/limit/epoch pins match. It still collects the full bounded source snapshot per request and grants separate leases; only index rebuilding is skipped. Correct stale §30.22 prose and do not claim scan savings.

## 2026-10-21 07:17 UTC — current owner checkpoint

Active phase owners: P1 Guard/ExecutionHost, replacement P2 managed/direct child lifecycle (after model-capacity failure), and P3 RepoIntel. P1 is implementing authenticated same-owner live Attempt scope recovery and trusted-only principal stamping for server-auth Session creation; P2 owns matching TaskTool child-session/wake/resume callers and exact DTO integration. P1 is also asked to provide explicit finite CodeMode timeout/tool-call/output limits while keeping CodeMode unavailable and making no hard-memory claim. P3 source review confirmed existing query_structure cannot enumerate directory/file entries; repo_tree and repo_detect remain unavailable, and no local nodeSource fallback may remain callable. The external host-path attachment was not accessed because the repo-only boundary forbids all external paths; local repo references remain available. No tests/builds/typechecks/audits/benchmarks/provider calls/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 07:21 UTC — P3/P6/P2 status

P3 source handoff PARTIAL: `repo_tree`/`repo_detect` remain unavailable because authenticated `query_structure` returns lexical occurrences rather than directory entries, while `read_document` cannot distinguish absence from denied/stale/error. Their old app-process filesystem implementation is inert and absent from the registry. Managed artifact search stays on ArtifactControl/HostKernel; cache docs now reflect fresh source snapshot per query and cross-Session immutable-generation reuse only. Active whole-phase owners are P1, P2, P6. P2 is inspecting the broad missing-handler mismatch in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` against repository index/HEAD before narrowly restoring required declarations; preserve all current unrelated/owned route changes and keep effects disabled. No checks or live calls ran.

P1 continuation: CodeMode adapter now supplies trusted 30 s / 64-call / 64 KiB bounds and caps fully formatted success/failure output; model exposure remains absent and no hard memory ceiling is claimed. P1 has confirmed no secure native credential input bridge or probe grant exists; P6 must leave credential mutation and live Doctor probes unavailable while closing independent work. The managed direct snapshot now returns an exact live `directAttempt` scope only after authenticated same-owner and live Attempt/epoch/workspace checks; P2 owns strict Core use.

## 2026-10-21 07:24 UTC — owner refill

P1 returned source-PARTIAL. Source now includes authenticated same-owner live direct Attempt scope recovery, trusted server-auth Session principal stamping, and explicit trusted CodeMode runtime/output limits; CodeMode remains unregistered. Protected-native credential writes and live Doctor probes lack an authenticated grant and remain unavailable. P3 returned PARTIAL with tree/detect unavailable due to missing HostKernel enumeration semantics. Active whole-phase owners are P2, P6 and P7. P7 resumed for complete stream/render/artifact/analytics/automation/rewind source work; all effects remain gated pending P1 acceptance. No tests/builds/typechecks/audits/benchmarks/provider or release operations ran.

P2 source continuation found and is repairing additional direct-turn integration defects: revision number/string mismatch, profile revision/scope decoding mismatch, BigInt JSON serialization, wrong TaskTool profile decoder input, duplicate current child declaration, and undefined parent variant. These are source blockers discovered by inspection, not test failures. No checks run.

P7 interim audit: current activity stream is mounted and replay/source-generation plus renderer redaction/bounds are source-present. Checkpoint preview/list routes exist, but capture/restore still return explicit 503; automation CRUD/reconcile exists, while `run_now` stays disabled without accepted canonical schedule semantics and Guarded invocation. P7 continues independent artifact/analytics/transcript source work; no checks ran.

Attachment correction (2026-10-21): the newly authorized single user attachment has now been read. It reinforces the full V1 objective, source-first local OpenCode/Codex adaptation across phases, implementation-before-tests, full architecture/event-flow re-audit, documentation continuity, and listed escalation for unresolved changes. No other external file/service/remote was accessed.

P6 source audit found FeatureExposure metadata omits owner/runtime prerequisites and supported platform/model/harness details required by §16.15; P6 is correcting Core descriptor/schema/TUI projection and the owner doc. No probes or checks run.

P7 added source bounds for printable tool-name activity labels and bidi/control stripping; resnapshot-triggered recovery validates Session IDs and caps attempts at 64. Fixture source is unrun and §31 was updated. Checkpoint capture/restore lacks an exact HostKernel contract/fixed-Git fact set; scheduled run-now lacks a canonical timezone-aware producer, so both remain unavailable. P7 continues artifacts/analytics source closure.

P2 source update: missing Session route declarations were restored from repository index while preserving newer Question/subagent/Guard handlers. Wire fixes include profile harness decode, trusted Task/child context, DirectAttempt u64/profile/scope decoding, snapshot authority matching and BigInt-safe delivery IDs. P2 is wiring same-live-Attempt resume via live HostKernel scope recovery, exact fresh proof, Guard inbox commit and turn_begin; runtime remains disabled pending integration/security acceptance. Follow-up wake and exact restart replay for pending delivery/completion remain open. No checks.

Resource check: C: via `/mnt/c` has 18 GB free of 454 GB (97% used), `kernel/target` is 627 MB, and only the primary agentx worktree is listed. Avoid build-heavy work while the user-directed implementation hold remains.


2026-10-21 implementation checkpoint: P1 owns the exact schema parity and HostKernel ToolBatch deadline changes; P2 does not edit the shared schema. P1 still owns kernel artifact/automation/checkpoint Guard boundaries. P7 continues its full phase in separate TUI/render files. P6 continues provider/settings/Doctor/S1 source work. Keep CodeMode execution hidden pending canonical Rust Guard/lease/receipt/recovery; interpreter caps do not imply memory containment. Eval additions should retain paired fixed-model baseline/full/ablations, frozen task IDs/config, objective verifier evidence, honest infrastructure/budget failures, provenance, resume without duplicate trials, and exact route authorization. No validation or live model work yet; do not start tests until implementation is complete per user instruction.


2026-10-21 continuation: active implementation slots are P2 managed/child lifecycle, P3 RepoIntel (then immediate P1 Guard continuation), and P7 streaming/render/artifact presentation. P6 finished its currently unblocked source pass; protected credential/live Doctor remain gated on P1. P5 source audit confirms cascade/settings fixtures exist but remain unrun and runtime false. P7 is adding the missing checkpoint TUI entry while preserving disabled restore. No tests/builds/typechecks/provider calls/evaluations/release actions. Keep all runtime gates false until cross-phase acceptance.


2026-10-21 implementation progress: P3 added UTF-8/query/path validation and authored unrun schema-rejection fixtures; tree/detect remain unavailable pending the user's decision on a new authenticated bounded HostKernel discovery DTO. Direct artifact ownership also lacks a resolver. P7 added aggregate SSE queue byte limits, a read-only checkpoint list/preview dialog and bounded printable transcript labels; restore remains unavailable. P2 owner is auditing the Core managed/child lifecycle. P1 will resume Guard source review after P3. These are source changes only; no validation or external calls.


P7 follow-up: checkpoint preview now renders IDs, paths, digests and conflict labels through bounded terminal-safe redaction while preserving exact raw IDs for SDK requests. Authored fixture coverage includes bidi/control characters, Bearer redaction, limits and raw-ID preservation. No tests run; restore remains unavailable.


P1 current blocker: no durable boot-scoped containment identity is retained to prove a stdio process tree is quiescent after abrupt HostKernel owner loss. The live-process PTY janitor and bubblewrap `--die-with-parent`/PDEATHSIG do not give a fresh HostKernel restart proof. Keep unresolved effects UNKNOWN and protocol/verifier gates false; do not use PID-only kill. P1 is checking the local Codex/OpenCode supervisor implementations before settling whether an existing safe primitive can be adapted.


Owner handoff update (2026-10-21): P2 source audit found TaskTool, authenticated follow-up runner, committed inbox claim, turn begin/complete, scope refresh and restart fencing present; runtime remains disabled pending P1/P8. Its owner is now on P4 source completion. P7 returned PARTIAL; its slot is on P8 resources/workers/RC0/HUP. P1 remains the critical Guard owner. Correction to the prior P1 note: `repos/codex/codex-rs` exists in this workspace; an earlier claim that it was absent was wrong and is being rechecked against the actual local source. No tests, builds, typechecks, provider calls or benchmarks.


User decision (2026-10-21): add the authenticated bounded HostKernel discovery/manifest DTO for P3; keep `repo_tree`/`repo_detect` gated until integrated acceptance. P1 owns the HostKernel contract/schema and will hand the precise revision to P3. Codex restart review is corrected: local Rust source exists; its process groups/PDEATHSIG, process-local Windows Job handles, and persisted single-daemon identity do not prove descendant quiescence after restart. P4 found production LSP supervised launch is not wired; a narrow `session/prompt.ts` authority-scope seam is now P4-owned, while launch remains gated on P1. No checks executed.


P8 update: resource/worker Rust files remain proof-gated and preserve OS quotas as unsupported, advisory pressure as unwired, worker settlement as proof-gated, and fan-out closed. RC0 test fixtures now use repository-local scratch instead of default OS temp paths; an unrun locality fixture was added. Remaining P8 blockers: P1/P2 owner-backed HostRun and verifier attestation, quiescence/effect/final-revision evidence, trusted resource ingress/retention, and real OS CPU/memory/process/FD limits. HUP live evaluation remains disabled.


Active phase ownership refresh: P1 HostKernel Guard + approved P3 discovery DTO; P4 LSP/DAP/REPL source integration; P9 local release tooling. P8 source pass is partial and its slot moved to P9. P2 source pass is partial, fail-closed pending P1/P8; P3 adapter waits on P1 DTO. P5/P6 source is present for unblocked work; P7 source is partial. No tests/builds/typechecks/provider/benchmark/release commands have run.


Current owner slots: P1 Guard + approved discovery DTO; P4 supervised LSP/DAP/REPL source work; P9 bounded local release audit/tooling. P1 additionally rechecked actual Codex process sources and found no restart-proof descendant quiescence primitive. P8 partial handoff is complete; RC0/worker proofs remain gated. No test/build/typecheck/provider/eval/release command has run.


P1/P3 integration progress: the approved bounded discovery contract now exists in RepoIntel schema, HostKernel and Core SessionSupervisor source. The response binds authenticated principal, Session, Location, owner epoch, workspace binding, source revision, read-policy digest, root, mode, limits and coverage; HostKernel rechecks Guard/read scope and request deadline. P1 is handing the exact DTO to P3 for model-tool adapter wiring; `repo_tree`/`repo_detect` remain hidden pending acceptance. Source only, no validation.

2026-10-21 continuation decision: the user approved optional cgroup-v2 process-tree containment under the existing ExecutionHost. P1 owns source and authoritative contract updates. Require delegated cgroup-v2 availability, pre-dispatch assignment, durable boot-scoped exact identity, and same-identity restart reconciliation; only confirmed empty (`populated=0`) after kill/wait settles quiescence. Otherwise preserve UNKNOWN and keep effects gated. No PID-only kill, second supervisor, or CPU/memory/FD quota claims. P3 received the `repo-intel.v1/discover` DTO contract for bounded authenticated tree/manifests; routes remain hidden. Source-only; no verification run.

2026-10-21 P3/P4 implementation continuation: P3's tree/detect adapters now use the HostKernel-authenticated bounded discovery operation and pinned document reads; symlinks are not traversed and routes remain absent from model registry pending acceptance. P4's lazy LSP clients are scoped to fiber-local authenticated ExecutionScope and call HostKernel approval/process lifecycle plus per-operation Guard protocol mediation; DAP and REPL work continues. P1 is implementing cgroup-v2 only if the existing ExecutionHost launch seam can guarantee target code does not run before membership is verified. P2 is active on the entire managed/child phase; P9's source pass returned partial. No checks run.

Managed budget decision: authenticate and validate the canonical AgentProfileV2 definition at Task creation, then immutably pin its `limits.tokenBudget` with profile ID/revision/digest. HostKernel returns `effectiveMaxTokens=min(SpecVersion.maxTokens, pinned tokenBudget)` for scheduling and durable decimal-u64 `remainingTokens` on each usage receipt/scope refresh, bound by the authority digest. Core clamps each managed provider step; direct Sessions are unchanged. P1/P2 are implementing this; no checks run.

P1 cgroup-v2 progress: existing StdioExecutionSupervisor now assigns the child into a newly created per-execution cgroup in pre_exec; the cgroup identity is persisted in EffectHost's existing PREPARED transaction before that barrier can exec. Normal/cancel settlement requires exact identity and `populated=0`, storing a durable quiescence digest; restart recovery can prove quiescence but keeps effect outcome UNKNOWN. Empty-cgroup cleanup for settle/discard is source-present; remaining failure-cleanup/origin audit is active. Internal REPL DTO is being added under the existing HostKernel. No tests run.

P2 exhaustion/recovery progress: zero remaining tokens is an authenticated STOPPED projection, and Core/OpenCode stop before additional provider/effect admission. Child settlement is FAILED/nonretryable only after HostKernel quiescence; restart consumes exact returned/quiescence receipts and never replays. Managed dispatch and verification/finalization are hard-disabled without env override. P4 has added DAP exact status/cancel and REPL profile/process lifecycle source, still gated; execute/reset/callback typed receipts remain in progress.
## 2026-10-21 — source continuation and owner refill

P1 source-wired optional Linux cgroup-v2 containment through the existing non-PTY ExecutionHost. The launcher joins its persisted cgroup before `exec`; normal/cancel/restart quiescence requires exact boot/root/inode/process/effect/profile/lease pins and confirmed `populated=0`. Empty directories are retained to avoid name-based deletion races. This is containment only; OS CPU/memory/process/FD quotas remain unsupported, and PTY remains disabled. P1 added typed internal REPL `repl_op` plus authenticated `repl_next_sequence`; execution stays unavailable until actual OS quotas and callback/result receipts are accepted. P4 now consumes the exact sequence contract and continues LSP/DAP/REPL source work behind gates.

P7 handed off PARTIAL after adding a bounded JSON preflight before SSE serialization and updating its owning architecture/test sections. Replay ownership for transient projections, complete same-revision checkpoint facts, canonical schedule semantics, guarded automation recovery, and final renderer/activity/artifact/analytics acceptance remain open. Checkpoint restore and `run_now` remain denied.

The newly free slot is assigned to P2's whole managed/direct child lifecycle phase. Active owners: P1, P2 and P4. P3 discovery tools are source-wired but hidden; P5/P6 routes remain gated; P8 needs P1/P2 receipts and unsupported OS-quota/attestation evidence; P9 release/legal/signing/candidate gates remain open. Preserve mixed Git state. No tests/builds/typechecks/audits/provider calls/benchmarks/release commands/Git publication ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 — P2 dependency handoff; P8 resumed

P2 reports its unblocked Core/TUI source complete for now and is PARTIAL/queued. It updated §29/§37 with source-present managed token projection and direct-child follow-up lifecycle. It cannot safely progress until P1 supplies Guarded verifier/effect receipt plus cgroup-quiescence/fresh-process recovery evidence, and P8 supplies final-Inspect/terminal settlement proof. Keep managed dispatch, verifier/finalization and fan-out disabled until integrated acceptance. The slot is assigned to a whole-phase P8 owner for worker/resource/worktree/RC0/evaluation source closure. P1 and P4 remain active. P4 now fetches and classifies the exact HostKernel REPL sequence before Guard, validates DAP attach against HostKernel-minted same-scope terminal refs, and pins LSP caches to Session/Attempt/workspace/profile; all runtime gates remain false. No tests/builds/typechecks/audits/provider/evaluation/release commands ran.
## 2026-10-21 — P1/P4/P8 source review update

P1 added a 256-entry retained-cgroup ceiling. The directory scan now stops at 257, rejects unexpected names and read errors, and serializes count/create with process and directory locks; if safe locking is unavailable, launch fails closed. This is source-only and still needs acceptance. P4 records DAP attach as unavailable because current bwrap `--unshare-all` isolates the adapter and target PID namespaces; its target-ref binding is not sufficient evidence to enable attach. P8 added repo-contained no-follow bounded RC0 input reads and frozen-seed parity checks for the fake paired runner. No checks ran.

Parent review found the P7 SSE event bound has two open source gaps: `Object.keys` materializes the full key list before node limits apply, and the queue retains a mutable event that is serialized later. Keep the SSE event source gate pending bounded own-key traversal and a synchronous bounded serialization/snapshot. Active owners P1, P4 and P8; P2 is queued for P1/P8 receipts. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 — P4/P8 handoffs; P6/P7 resumed

P4 is PARTIAL: LSP/DAP/REPL source is present, but runtime remains closed. DAP attach cannot be enabled with separate bwrap PID namespaces; it needs a shared-debug namespace and ptrace policy. DAP evaluation needs trusted profile policy; LSP needs authenticated ingress/document-buffer acceptance; REPL needs OS-enforced quotas and typed callback/result evidence. P8 is PARTIAL: bounded repo-local no-follow RC0 input plus HUP fake-runner seed/resume/cancel accounting are source-present; no trusted HostRun/verifier attestation, OS quotas, authenticated pressure input, or worker settlement proof. P7 resumed whole-phase work to repair own-key enumeration and immutable serialization in SSE preflight, then close all remaining P7 source gaps. P6 resumed whole-phase provider/settings/Doctor/S1 work; no provider/live probe calls. Active owners P1/P6/P7. P2/P4/P8 remain queued or proof-gated. No checks/builds/typechecks/audits/evaluations/provider/release commands ran.

## 2026-10-21 continuation — current phase owners and integration findings

P1, P6 and P7 are the active whole-phase owners. P1's optional cgroup-v2 path is source-wired to the existing non-PTY ExecutionHost with exact persisted identity and empty-cgroup restart proof; PTY and unsupported paths remain unavailable. P1 is closing direct first-party process origins. Both SDK server/TUI launcher APIs spawn `opencode` outside HostKernel; parent directed these exports to fail closed before spawn in V1. P6's offline Doctor and settings truth fixes are source-present; a title-generation fallback to a provider small model needs P2's correction to retain the Session-pinned selection unless explicitly configured. P7's bounded SSE traversal and queue-time immutable serialized snapshot are source-fixed and documented. None is verified; no tests/builds/typechecks/provider calls or other acceptance have run. P2 is queued pending P1/P8 evidence, P4 remains partial/gated, P8 remains partial/gated, and P9 exact-candidate release acceptance is open. Do not enable dependent effectful paths or promote V1 status.

## 2026-10-21 phase owner refill and source audit

P1 source audit completed for inspected origins: direct TUI/SDK spawn APIs are closed, plugin/MCP/hosted adapters are unavailable or gated, shell is Guard/HostKernel-mediated, LSP/DAP/REPL routes are gated, and the remaining CLI package launcher is user-invoked and unreachable from model/tool dispatch. cgroup-backed dispatch/restart still lacks integrated evidence, so this is not phase acceptance. P6 handed off PARTIAL with source fixes to settings lock truth, offline Doctor missing-model state, model capability/freshness labels, and legacy question callbacks; credential/probe grants, Guarded search, FEAT/S1 and provider journeys remain. P7 handed off PARTIAL with bounded immutable queued SSE snapshots and safe timeline labels; checkpoint capture/restore, scheduled invocation and transient-event replay remain unresolved. Active phase owners: P2, P4, P8. P2 owns the Session-pinned title-model correction; P4 owns LSP/DAP/REPL; P8 owns resources/workers/RC0/HUP. No checks or external operations ran; mixed Git state remains untouched.

## 2026-10-21 critical-path owner update

Active whole-phase owners: P1, P2 and P9. P1 resumed to close remaining Guard/ExecutionHost implementation, with priority on exact-contract protected native input and authenticated Guarded SecretBroker/probe grants blocking P6/P5, and remaining dispatch/recovery edges. P2 continues managed/direct child lifecycle and must preserve the Session-pinned model for implicit title generation. P9 continues repo-local distribution/release source; no external or remote actions. P4 handed off PARTIAL with LSP/DAP/REPL false-gated pending P1/P3/OS proofs. P8 handed off PARTIAL with no independent source gap; worker fan-out, cache eviction and RC0 attestation remain disabled without the exact proof/OS quotas. P6/P7/P3/P5 remain partial or gated. No checks/provider/evaluation/release/publish ran.

P2 corrected implicit title-model drift: absent an explicit title-agent model, title generation now uses the Session-pinned provider/model. P9 is correcting release qualification workflow output paths from `/tmp`/`$RUNNER_TEMP` to repository-contained paths and scanning workflow source only. Both remain unverified; active owners P1/P2/P9.

P2 handed off PARTIAL: title generation now preserves Session-pinned provider/model, and managed dispatch uses only the Rust-pinned profile model. Remaining managed verifier/evidence/finalization and acceptance depend on P1/P8. P5 is now active as a whole-phase owner, auditing/closing approved cascade source without provider calls and preserving explicit route consent/no paid fallback. P1 and P9 remain active. P4/P8/P2 are queued on proofs; P6/P7/P3 remain partial/gated. No validation or external operations ran.

P9 moved CI qualification artifacts from host scratch locations to `$GITHUB_WORKSPACE/kernel/target/horizoncode-release/ci-<run>-<attempt>/`, added unrun assertions against `/tmp` and `$RUNNER_TEMP`, and documented the manual read-only/no-publish qualification workflow. Local installer/upgrade stay fail-closed. No workflow or release script was executed.

P1 source update: SecretBroker put/revoke now fail closed before broker mutation while its Guard gate is false; owning §14.22 records the missing write-grant/protected-input contract and Doctor grant/policy schema. P1 will not invent authority. ToolBatch admission/cancel semantics were source-reviewed; exact integrated receipt/recovery remains unaccepted. Retained cgroups are capped at 256 due no race-free inode-targeted removal; dispatch eventually fails closed at the cap. P5 verified its Core cascade wire against existing HostKernel RPCs and is closing a legacy exported direct callback executor. P6 resumed source audit. P9 handed off PARTIAL after repository-local qualification artifacts, bounded legal inventory and strict installer version handling. Active owners P1/P5/P6; no tests/builds/providers/releases.

P6 source correction: only exact `unlocked` settings can project `pending_apply`; unknown lock state is blocked with an uncertainty reason. P1 handed off partial source with SecretBroker/protected-input and Doctor grant schema gaps recorded; those routes remain unavailable. P1 source review confirms batch bounds/atomic admission and per-effect one-use leases, not acceptance. Active owners P3/P5/P6; no tests or network operations.

P5 source handoff: production callback cascade executor is removed; the simulator is test-only and the source fixture asserts no callback effects. Route classification/provenance/consent source matches approved behavior, including one fall-through for auth 401/403/407 and stop for other 4xx; runtime remains gated. P6 handed off PARTIAL with Settings lock-truth corrections; provider grants remain absent. P3 is active and found missing depth/order/duplicate/mode checks in the P1-owned discovery response projection; P1 resumed to own the supervisor fix. Current active owners P1/P3. No verification/provider calls.

P2 handed off PARTIAL after adding the Session-pinned title-model default and making Goal verification UI unavailable by default; the mounted app has not opted in. Its remaining managed vertical depends on P1 verifier recovery/launch and P8 settlement acceptance; P1 is addressing restart recovery of a lost verification challenge set. P4 resumed whole-phase source work against current P1/P3 contracts. Active owners: P1/P3/P4. No tests/builds/typechecks.

Parent resolved the §12.19 challenge-recovery gap: P1 is adding a HostKernel-idempotent verifier-set API keyed by a digest of exact authenticated Run/Attempt/epoch/Spec/profile/final-revision/evidence-plan pins. It stores the whole set before exposing challenge IDs, returns the same set on exact retry, conflicts on mismatched pins, and never recreates partial/UNKNOWN sets. P2 resumes when the DTO is source-present. P1 is also adding digest-bound optional DAP `allowEvaluate`; absent/false denies and runtime remains gated. These are source contracts, not acceptance evidence.

P3 handed off PARTIAL with bounded manifest detection and aggregate exact-revision document-byte limits; tools remain hidden pending integrated acceptance and parser/buffer/cache features remain gated. P2 resumed against P1's new verifier-set recovery contract. Current active owners P1/P2/P4.

P1/P2/P4 current source integration: strict DAP-only `allowEvaluate` is default-deny, included in immutable profile digest, retained per process generation and checked before both approval and dispatch; P4 sends explicit false. §12.19 verifier-set restart recovery now has a parent-approved HostKernel-derived idempotency key over the full trusted Run/Attempt/epoch/Spec/profile/final-revision/evidence-plan tuple; exact awaiting set only, with mismatches/other states fail closed. P1 implements the durable boundary; P2 consumes it. Unverified source only.

P4 source progress: Core DAP config/projection now uses DAP-only immutable `allowEvaluate` with explicit false default; evaluation still requires true plus existing per-call Guard. LSP status for cached services uses HostKernel execution status at the exact scope and cannot start a process. P1 owns matching Rust/schema enforcement. Editor ingress/document synchronization and REPL callback/recovery remain under source review; attach and execution remain unavailable. No tests.

P4 added a constant-false REPL callback ingress and unavailable capability projection because the HostKernel callback/event receipt contract is absent; a source fixture prevents candidate event promotion. Local ledger is not evidence. No interpreter effect is enabled.

P4 handed off PARTIAL: default-deny DAP evaluate, exact-scope read-only LSP status, and false-gated REPL callback ingress are source-present; document buffers/production editor ingress, shared DAP namespace/ptrace, OS quotas and callback receipts remain. P8 resumed for whole-phase worker/final-Inspect/OwnerLog recovery source against P1/P2's new verifier-set work; fan-out/cache eviction/RC0 remain gated. Active owners P1/P2/P8.

Verifier-set DTO remains in progress. Require explicit typed trusted authority pins plus `verificationRunID`, `setIdentityDigest` and `challengeSetDigest`; Core and P8 must cross-check and carry these through final Inspect/terminal settlement. Do not rely on an opaque set digest or evidence digest alone. P1/P2/P8 coordinate exact wire shape; no validation.
**P5 source handoff — 2026-10-21:** successful web-search metadata and user-visible
text now share the bounded typed result projection, including measured aggregate
latency and parser-derived truncation truth; attempt metadata is bounded and
sanitized, aggregate error text is generic, and ambiguous runtime errors remain
UNKNOWN. TypeScript and JSON provider-ID constraints align. Search is still hard
gated pending P1 Guarded transport/receipt acceptance and P6 SecretBroker acceptance.
No checks/provider calls were run. P5 source work is complete for currently
unblocked projection/document items; integrated acceptance remains blocked by P1/P6.

P2 resumed after P1 confirmed the ChallengeSetV1 wire. Core strictly decodes the full challenge identity pins and UNKNOWN recovery, compares accepted Spec/Run and terminal snapshot identity, forwards only HostKernel-decoded branded pins to settlement, and requires the P8 receipt to echo verifierRunID/setIdentityDigest/challengeSetDigest. The Goal verification response schema and generated JS DTO include set identity. P1 still owns full settlement-recovery projection and settle_dispatch validation/receipt echo; P8 still needs to bind the identity to final Inspect/worker settlement. The route remains disabled. No tests/builds/typechecks run.



## 2026-10-21 12:57 UTC — implementation continuation / owner refresh

User reaffirmed implementation-first and approved optional Linux cgroup-v2 containment for restart proof. Bootstrap was refreshed from root instructions, trackers, V1 architecture/governance and operative plan. Repo-only boundary remains in force: no host paths, external services, Git remotes, checks/builds/typechecks/audits/provider calls/evaluations/releases, or Git staging/publication. Git state remains mixed and unstaged (198 modified paths, 76 untracked at refresh); one repository worktree; repo-local kernel/target is 627 MB and filesystem reports 817 GB free. No cleanup performed.

Active whole-phase owners (3 child slots): P1 Guard/ExecutionHost (agent_lifecycle_opencode_codex), P3 RepoIntel/Discovery (v1_phase_source_inventory), and P7 stream/render/artifacts/analytics/automation/rewind (arch_audit_contract_flows). P2 source handoff is PARTIAL and not accepted; its exact verifier settlement integration still depends on P1/P8 proof. P4/P5/P6/P8/P9 remain PARTIAL, gated, or queued. P1 cgroup-v2 is optional and Linux-only; assignment requires authenticated delegation, identity is persisted before dispatch, restart recovery reconciles only the same verified cgroup, and uncertain/non-empty state remains UNKNOWN/disabled. No quota guarantees or unsupported native Windows acceptance are implied.

Parent approved two bounded cross-owner source tasks: P3 may add the missing discovery request/page union arms to the canonical RepoIntel JSON Schema matching TS/HostKernel DTOs; P7 may repair only refreshSessionMessages reconnect bookkeeping in packages/tui/src/context/data.tsx to preserve/detect live deltas during canonical pagination, leaving P6 question handling untouched. Parent updated arch_V1/37-RUNTIME-SERVICE-LLD.md §37.11 to make V1 SSE explicitly live-only (no SSE id/global Last-Event-ID), specify per-part sequence/sourceGeneration fencing and canonical owner resnapshot, and record the overlapping-fetch race requirement. These are source changes only. No checks have run. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:59 UTC — overlay visibility correction

P1 discovered `kernel/src/cgroup_v2.rs` was hidden by the root overlay ignore policy, despite being included by `kernel/src/lib.rs`. Parent added the narrow `!/kernel/src/cgroup_v2.rs` exception in `.gitignore` and informed P1; the source remains unverified, and the full overlay audit is still deferred with the rest of implementation-first checks.

## 2026-10-21 13:00 UTC — P7 reconnect source handoff; P4 slot refill

P7 completed the source repair of the canonical Session refresh race: overlapping message fetches coalesce; live Session deltas advance generation; pagination retries once; a repeatedly moving source preserves the live projection/cursor rather than overwriting newer events. The change is bounded to refresh/reconnect bookkeeping; P6 question handling was not edited. §31/§45 now reflect this. No checks were run; P7 remains PARTIAL pending full TUI/stream/artifact/analytics/recovery acceptance and P1/P2 dependencies for effectful automation/checkpoint paths.

Available slot is assigned to P4 as a whole-phase source owner for supervised LSP/DAP/REPL integration. Current active owners: P1, P3, P4. P1 cgroup module Git visibility is restored by a narrow root ignore exception; P3 is aligning the missing discovery JSON Schema arms. All three phases remain unverified; implementation-first hold continues.

## 2026-10-21 13:02 UTC — P3 source/docs pass complete; P8 slot assignment

P3 completed its unblocked source/docs pass. The RepoDiscovery request/page union arms now mirror the strict TS/HostKernel DTO in the canonical JSON Schema; §30, §32, and §33 no longer claim discovery is absent and now describe the feature as source-present but gated. Remaining P3 blockers are intentionally fail-closed: registry/cursor use await integrated acceptance, parser-backed semantics lack approved provenance, overlays lack trusted immutable editor-buffer ingress, and cache eviction lacks an authenticated pressure trigger. No schema validation or tests were run.

The freed P3 slot is assigned to P8 whole-phase source integration, prioritizing the P1/P2 verifier-set pins through durable worker/final-Inspect/settlement receipts, then remaining unblocked resource/RC0 source. Current active owners: P1, P4, P8. P1/P4/P8 remain source-only; no validation commands have run.

## 2026-10-21 13:04 UTC — P1/P8 final-Inspect verifier-pin integration

P1 source review closed an identity-binding gap: cgroup `process_kind` is now checked against the persisted capability at preflight, terminal settlement, and startup/restart reconciliation using the canonical stdio process-kind mapping. No validation was run.

P8 confirmed worker terminal settlement already persists and replays opaque verifier-set pins with P2/P8 receipt identity checks, and FAILED/CANCELLED quarantine remains pinless. A newly found source gap is that the P8 managed final-Inspect candidate pin/digest does not yet bind `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`. P8 owns the worker_durable candidate contract; P1 owns HostKernel prepare/execute/recovery resolution and must pass the exact HostKernel-issued settled token. P2 candidate code is not to be edited. This integration is in progress; no tests.

## Current continuation checkpoint — 2026-10-21

Comparative Pi/Codex research is recorded in `docs/research/2026-10-21-pi-codex-harness-decisions.md`
and cross-referenced from `arch_V1/29`, `/30`, `/31`, `/42`, and `/45`. The architecture
reuses existing Core/Rust owners rather than adding a second harness. Automatic cache warming
and hosted sharing are deferred; models.dev remains the existing metadata catalog; CodeMode
remains gated on P1 Guard/ExecutionHost acceptance.

P1 and P3 source passes are complete for currently unblocked work; P4 and P8 source handoffs
remain partial and unverified. P6 is the next active whole-phase source assignment. A separate
Codex research owner is checking exact local lifecycle/event/UI patterns. Continue source
implementation only until the implementation-first hold is explicitly lifted; then run final
integrated verification against the exact final revision. All Git changes remain unstaged; mixed
user/task ownership requires exact-path review before any publication.


## 2026-10-21 — Codex comparison completed; whole-phase source owners refreshed

The deeper local Codex lifecycle/event/UI review is recorded in §42.17 and the comparison note.
Codex's separate operation/activity events, reserve→create→persist-lineage→accept-input order,
separate admission/execution/residency budgets, bounded activity overview, and parallel-work
guidance are useful patterns. Its topology/thread history persists, but mailbox/runtime state and
completion notification are process-local/best-effort; HorizonCode's explicit durable delivery,
named wait, Attempt authority, and receipt reconciliation remain the stronger contract. No new
schema/runtime was justified and no upstream code was copied.

Active whole-phase source owners: P2 delegation (Codex research agent reassigned after completing
research) and P6 providers/settings/Doctor/S1 (source inventory agent reassigned after P8 pass).
P1's current source integration and P3/P4/P8 unblocked source passes are complete for now, but
remain PARTIAL/NOT VERIFIED because acceptance and dependencies are open. P8 verifier pins now
flow through all five HostKernel→worker final-Inspect/replay/recovery paths and bind the verifier
IDs/digests in its candidate/receipt; worker fan-out, cache retirement, hard OS quotas and RC0
remain gated. No tests, builds, typechecks, audits, provider calls, benchmarks, or release checks
were run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:10 UTC — P6 handoff and P7/P9 slot refill

P6 completed its unblocked source pass: provider/model routing and explicit free-route eligibility,
settings provenance/lock semantics, offline Doctor, and S1 ownership/callback paths are present.
Provider Doctor TUI now renders the server's VALID/INVALID/UNKNOWN configuration status rather
than conflating a probe PASS/FAIL with configuration validity. Credentials and live probes remain
closed pending P1 authorization; real provider journeys and FEAT/QA acceptance are not run.

The available whole-phase slots now belong to P2 delegation, P7 streaming/rendering/artifacts/
analytics/automation/rewind, and P9 packaging/release-readiness source. All three work source-only;
no validation/release commands run during the implementation-first hold. P1/P3/P4/P5/P6/P8 have
no currently assigned source worker and remain partial/unverified or gated as listed in the phase
ledger. Research/docs are in `docs/research/2026-10-21-pi-codex-harness-decisions.md` and §42.
No changes are staged or published; existing mixed Git work is preserved. V1 remains PARTIAL /
NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:12 UTC — P7 source pass and P1/P2/P9 owner allocation

P7 reviewed all remaining unblocked source and found no safe change beyond the current bounded
stream/redaction, replay fencing/resnapshot, activity, artifact/analytics, automation-management
and checkpoint-preview implementations. Effectful automation remains disabled; checkpoint
capture/restore and transient-event replay remain blocked on HostKernel facts/owners and Guarded
receipts. No tests/builds/audits were run.

Current whole-phase source owners are P1 Guard/ExecutionHost, P2 direct/managed delegation and
Goal review, and P9 local packaging/release-readiness source. The P2 review-inbox component exposed
source issues that its owner is correcting before route integration; the shared session route is
being coordinated to avoid P7/P2 writer overlap. P7/P6 source passes are complete but unverified;
V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Mixed Git state remains unstaged and preserved.


## 2026-10-21 13:13 UTC — P1 source pass handoff; P5 slot refill

P1's final source-origin pass found all reachable first-party process origins already rejected
before spawn or fail-closed behind HostKernel readiness. ToolBatch admission, durable receipt and
UNKNOWN reconciliation source are present. No safe P1 source expansion remains. P1 stays
PARTIAL/NOT VERIFIED pending Linux confinement/cgroup restart and crash/cancel/UNKNOWN acceptance;
SecretBroker mutation/live Doctor remain gated on trusted authenticated input/grant contracts.

The freed slot is assigned to whole-phase P5 cascade source closure against approved route order,
explicit opt-in, auth fall-through, provenance/retry/failure bounds, consent, and no paid fallback.
Current owners are P2/P5/P9. No provider calls, tests, builds, typechecks, audits, or release
operations have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:15 UTC — P5 source closure; P3 source owner reassignment

P5 compared the ordered cascade against the approved contract and found the source aligned:
explicit enabled-route order, auth 401/403/407 fall-through without retrying that route, stop on
other 4xx, bounded 429 cooldown/retry, ordered per-route provenance, consent and no paid fallback.
The production callback executor is absent and `WEB_SEARCH_RUNTIME_READY` remains false. P5 has no
unblocked source changes; runtime awaits P1/P6 acceptance.

The freed slot is assigned to whole-phase P3 RepoIntel/Discovery source continuation, reviewing
existing local OpenCode/Codex parser/query patterns and implementing only safe source gaps within
HostKernel's single authority. Parser semantics, unsaved overlays and cache eviction remain gated
unless their exact provenance/ingress/pressure authority exists. Current source owners: P2/P3/P9.
No tests/builds/audits/provider calls were run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:18 UTC — Resume state

P3 source work is complete for currently unblocked changes: terminal/invisible controls and
credential-like filename segments are sanitized for display without changing canonical HostKernel
paths, and tree truncation includes its marker in the 32 KiB bound. Parser-backed semantics,
overlays, public tree/detect, cursor runtime, and cache retirement remain gated. No tests ran.

P9 source pass is complete for currently unblocked work: five inherited publication workflows are
disabled by first-party overlays, direct package publication is fail-closed, container pushes reject
before Docker while local builds remain available, and distribution source checks cover those
guards. Legal/signing/toolchain decisions and exact-candidate verification remain open.

P6's source re-audit found no further safe gap: provider/model, settings, offline Doctor, and S1
source paths exist, while FEAT-001..014 and live/guarded journeys remain unverified.

Current active whole-phase owners: P2 managed delegation/Goal review and start, P4 LSP/DAP/REPL,
P8 durable worker/resource/RC0. P2's UI persists a PLAN_ONLY plan, then requires a second explicit
start action tied to the top-level Session and exact accepted Spec pins. It is checking whether
authenticated Goal/Spec/Profile selection projections exist; caller-provided profile authority must
not be trusted. P4/P8 work is source-only. P4 initially redirected a documentation command to
`/dev/null`, outside the path rule; it acknowledged the mistake and was told not to use any external
path again. No user files, external services, or Git remotes were used. Repo-only boundary applies to
all agents. No tests,
builds, typechecks, audits, provider calls, release actions, or Git publication were performed.
Mixed changes are unstaged; preserve them. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:21 UTC — Resume state

P4's currently unblocked source is complete: DAP evaluate requires trusted profile `allowEvaluate`
and HostKernel Guard policy; direct LSP/DAP callbacks remain behind protocol readiness. DAP attach
and REPL remain gated on OS, namespace/ptrace, quota, and authenticated callback recovery support.
P6/P8 source re-audits found no further safe additions; acceptance dependencies remain outstanding.

Current phase owners are P1 Guard/ExecutionHost, P2 managed delegation/Goal flow, and P7 stream/
render/artifacts/analytics/automation/rewind. P2 is implementing a bounded authenticated projection
for accepted Spec criteria and immutable AgentProfile candidates, then preserving PLAN_ONLY followed
by explicit `goal.start`; Core/Rust remain the authority for canonical digests and scope. P7 avoids
the P2-owned route. No checks, provider/network calls, staging, or remote operations. Mixed Git state
remains preserved and unstaged. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:22 UTC — Resume state

P1's final source re-audit found no safe change under the approved contracts. Process execution is
Linux-only through HostKernel/cgroup-v2, unsupported platforms and unmediated origins stay closed,
and Linux cancel/crash/restart/UNKNOWN evidence remains outstanding. SecretBroker mutation and live
Doctor probes remain blocked by missing §14.22 protected-input/grant/receipt contracts; routes fail
closed.

P7's whole-phase source audit found no additional safe source change. Effectful automation and
checkpoint capture/restore remain gated. Current active owners are P2 delegation/Goal review/start
and P5 web-search production integration. P5 is checking the existing Guarded network grant/receipt
contract; no authority may be invented and runtime stays unavailable if the contract is absent.
No checks or provider/network operations ran. Preserve mixed Git state; no Git publication. V1
remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:23 UTC — Resume state

P5's source pass is complete with no safe gap. Its ordered cascade and production HostKernel
lease/receipt path exist, but dispatch stays false pending P1 integrated Guard/recovery and P6
credential acceptance; native model-grounded search still lacks a real adapter/consent path.

P2 identified that the Rust PLAN_ONLY response omits canonical per-Task `profileDigest` and
effective permission-scope digest. P1 now owns adding Rust-minted pins to its response/schema;
P2 owns the Core/HTTP/SDK/TUI consumer and bounded authenticated selection. Never compute these
digests in TypeScript or accept user-supplied values as authority. Keep `goal.start` gated until
exact pins display and round-trip. Current active owners: P1/P2. No verification or provider/network
operations; mixed Git state remains unstaged. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:24 UTC — Planned scope digest correction

Correction to the 13:23 checkpoint: do not include `permissionScopeDigest` in PLAN_ONLY. The
effective ceiling digest binds authenticated Attempt ID and owner epoch, and is only minted after
Attempt admission. P1/P2 use distinct Rust-minted `acceptedScopeDigest` and
`profilePermissionCeilingDigest` plus profile ID/revision/digest and Run/Goal/Spec pins. UI labels
these as planned Task scope and profile ceiling; the actual effective permission scope is projected
after Attempt admission. Earlier wording that required the effective digest before `goal.start` is
superseded. No fake or client-computed authority.


## 2026-10-21 13:29 UTC — Resume manifest

The earlier 13:23 description is superseded by the 13:24 digest correction and current source: PLAN_ONLY contains Rust-minted `acceptedScopeDigest` and `profilePermissionCeilingDigest`, not the Attempt-bound effective `permissionScopeDigest`. P1 completed the Rust response/schema. P2 aligned Core/HTTP/SDK/TUI validation and projection to exact per-Task pins, including one-to-one matching and planned-scope labeling. No authenticated accepted-only Goal listing exists, so the bounded Goal-ID entry remains; other local stores are not accepted as managed Goal authority. Reviewer identity comes from TrustedPrincipalContext and same-workspace/stale-spec checks remain server-owned.

Current active whole-phase owners: P2 managed delegation/Goal flow, P4 LSP/DAP/REPL, and P8 worker/resource/finalization. P1 source handoff is complete; Linux crash/cancel/UNKNOWN and SecretBroker/Doctor contracts remain acceptance blockers. Continue source implementation only. Do not run tests, builds, typechecks, audits, provider calls, or release checks yet. Repository-only boundary prohibits external URLs/services/paths/remotes. Preserve mixed unstaged Git state; no cleanup, staging or publication. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:31 UTC — Resume manifest

P2 source work is complete for now: authenticated Goal/Spec/Profile selector, strict Core/HTTP/SDK validation of HostKernel's sorted per-Task PLAN_ONLY pins, planned-scope labeling, explicit exact-pin `goal.start`, and server-authenticated review/start checks. There is no accepted-only Goal list endpoint, so the bounded Goal-ID field remains. The earlier 13:29 “investigating” status is superseded.

P4 and P8 source passes found no unblocked phase-owned code gaps. P4 left effects gated on OS/Guard/REPL callback contracts; P8 left fan-out, unsupported hard resource limits, cache-pressure retirement and RC0 unavailable without authority/evidence. Active whole-phase owners are P6 providers/settings/Doctor/S1, P7 context/history/rendering/analytics, and P9 release-source readiness. P7 is implementing a bounded aggregate analytics view with token/cost provenance and truthful unknown remainder.

I added exact root ignore exceptions for the three P2 TUI dialogs after discovering they were hidden; Git status now exposes them. Mixed work remains unstaged and preserved (201 modified, 89 untracked; no staged files, one worktree). No tests/builds/typechecks/audits/provider calls or remotes until source implementation is complete. Repo-only restriction remains. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:35 UTC — Resume manifest

P6/P9 source passes are complete, unverified. P6 changed bundled-model freshness from unsupported FRESH to UNKNOWN and projects catalog source/freshness/update time into provider list and model picker. P9 changed local container namespace/tag behavior and hardened release-audit Git visibility; publish/sign/update paths remain disabled pending explicit product/legal decisions and acceptance.

P7 added bounded token/cost analytics in Debug with provenance-separated totals and unknown counts; it does not sum amounts across currencies. A newly discovered source gap reopens P1/P7 ContextSelection work: current ContextSelectionV1 only records Session message IDs and a cursor, and no actual prompt compiler consumes it. P1 owns strict schema/Rust decoder and canonical digest; P7 owns Core managed source resolution and consuming the exact HostKernel-returned binding before provider dispatch. Preserve legacy direct Session behavior without fake AgentProfileV2 pins; managed Tasks require the authenticated Task-pinned profile.

Parent review also fixed the P2 plan UI so it cannot silently drop accepted Spec capability requirements to match a weaker profile. P2/P6/P9/P4/P8 are source handoffs; current active owners are P1 and P7. No tests/builds/typechecks/audits/provider calls/remotes yet. No staging/cleanup/publication. Mixed Git state preserved; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 13:41 UTC — Current source ownership and blockers:** Pi/Codex comparison is expanded in `docs/research/2026-10-21-pi-codex-harness-decisions.md`. The in-repo Pi-like source is OMP fork `repo_take/oh-my-pi` at `a536558`, not Earendil Pi; it contains no Pi Durable package. The local Codex source `repos/codex` is at `14830654c` with 206 tracked modifications. No external URLs, services, or remotes were accessed.

Active whole-phase owners are P1 (Guard/ExecutionHost, ContextSelection authority and RepoIntel-safe workspace facts), P2 (managed lifecycle and per-request context transition), and P7 (request compiler/prompt integration plus streaming/render/artifact/analytics/automation/rewind). Managed selection currently pins empty pre-prompt context; per-request digests must bind the exact compiled model input and live Attempt/owner epoch. P3 unblocked source audit is complete but unverified; its safe discovery path is blocked because the shared workspace revision walker rejects symlinks before RepoIntel can list them without following. P1 owns the fix. Keep dependent dispatch and discovery capability gates closed until source integration and later acceptance.

Evaluation harness source is fake-provider-only. The existing benchmark plan documents corrected baseline provenance and a staged evaluation sequence; no tests, builds, typechecks, audits, provider calls, or benchmark runs have been performed. Mixed Git state remains unstaged and preserved. Repo-local disk has 815 GB available (`kernel/target` 627 MB). No cleanup or remote operations. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 13:44 UTC — Per-request context/API contract:** P1/P2/P7 agreed that managed ContextSelection is per provider request. Attempt admission binds sequence 1; every subsequent model call must receive an exact-next `managed_context.advance` receipt (2..1024) bound to request ID/digest and live Attempt/session/profile/owner epoch/current revision. The HostKernel event retains bounded refs only; exact retries replay the same receipt; gaps/conflicts/stale/terminal states deny. P1 owns Rust/schema/HostKernel, P2 owns managed-control wrapper and projection, P7 owns processor/LLM pre-provider compilation and immutable request handoff. This is source work in progress, not verification; gates stay closed.

The evaluation harness remains fake-only and cannot invoke product agents/providers or claim benchmark scores. Existing HUP docs define paired baseline/full-harness evaluation, ablations, uncertainty and a staged future smoke/held-out order. No tests, builds, provider calls, or benchmark runs have been performed.

**2026-10-21 13:46 UTC — TypeScript/Rust child Session identity mismatch:** TypeScript admitAttempt currently rejects ContextSelection.sessionID equal to the child Session, while HostKernel requires that exact Attempt child Session and separately checks parentSessionID. P2 owns aligning TS and carrying requestSequence/requestID/contextSelectionDigest through Core/OpenCode projections; P7 owns processor/LLM dispatch; P1 owns Rust validation/receipts. The digest must identify the child Session whose prompt is sent. No checks run.

**2026-10-21 13:48 UTC — Resume blockers:** The RESERVED pre-admission target projection promised by §37.22 is missing from the current `managed.ready_task_selection` response. P8 reservation state and internal target resolution exist; P8 must expose a bounded authenticated projection from the exact reservation proof. P2/P7 keep managed request 1 disabled until then. A fourth phase owner could not start because the three-child platform capacity is occupied; launch the whole P8 owner when a slot frees. Also ensure P1 implements the Rust `managed_context.advance` OwnerLog event and HostKernel endpoint required after seq1; P2's TS wrapper remains unusable until the Rust contract exists. No tests/builds/typechecks/audits/provider calls have run.

**2026-10-21 13:50 UTC — CodeMode source note:** first-party `packages/codemode` is an existing confined interpreter over explicit tools with progressive catalog discovery. It is not an authorization, durable task, replay, or receipt boundary; nested calls share an outer invocation without independent registry/output hooks. P1 must include it in effect-origin mediation or keep effectful nested calls unavailable. The Pi/Codex decision note records the source evidence and disposition. No checks ran.

**2026-10-21 13:52 UTC — Managed prompt hook constraint:** `LLMRequestPrep.prepare` invokes system-transform, chat-parameter, and chat-header plugin hooks. Do not run those as unmediated effects during pre-admission preparation. P7 should compile deterministically from trusted snapshots and disable managed mutating hooks until mediated, or route their effects through Guard first. Hash the same frozen provider body that is dispatched; pin route/approved non-secret parameters separately and exclude credentials from the digest.

**2026-10-21 13:54 UTC — hook boundary update:** P7 has disabled those transforms plus message transforms for managed LLM calls; direct sessions retain their behavior. P2 still needs to prepare the actual child Session request before admission and pass the identical frozen object to LLM. Recovery must reprepare and compare the complete DTO before consuming. No tests ran.

P1 reports source-present durable selection records and `managed_context.advance`; it has since added the complete Rust-authored scope (selection pins plus P8 target) to successful admission. Advance must return refreshed scope, and recovery still lacks a RESERVED P8 target. P2 must remain unavailable for recovery until the authenticated candidate/task-revision-bound projection exists; root `workspaceRef` is not a substitute. P7's `prepareManagedTaskRequest` remains an explicit unavailable stub until the reusable no-dispatch normalized prompt compiler is completed.

P2 recovery source now reparses saved seq1 refs, checks exact live pins/digest and full DTO equality before claim/consume, and passes one prepared value through prompt execution. This path stays unavailable because P7's no-dispatch compiler and P8's authenticated pre-admission target projection are unfinished.

Later-request recovery also needs a durable provider dispatch state: a saved context-advance proves prompt authority only, not whether an external model request began or incurred cost. Coordinate a one-use PREPARED→DISPATCHING→SETTLED state with P1/P2, and turn interrupted DISPATCHING into UNKNOWN without automatic replay. Bind it to the exact request ID/sequence/context digest/route/model/live Attempt. Until then, later managed provider requests remain fail-closed.

P1 found no Rust-owned managed inference route resolver, endpoint revision pin, or network Guard/consent boundary; Core's current ProviderTransport covers web search only. Do not mint send authorization from caller/Core route strings alone. P1 continues the Rust Guarded provider boundary against the existing Core provider owner; keep send disabled until authenticated route pins and Guard/consent/budget checks exist. Queue P6 Core route adapter work for a free phase slot if required. No provider calls under the repository-only/source-first hold.

**2026-10-21 — HTTP transport reuse:** Parent source review confirms HostKernel already has one
bounded `HttpExecutionSupervisor` and durable HTTP effect receipt/recovery lifecycle. Its route
validator is deliberately fixed to web-search inputs, so model-provider dispatch needs a separate
typed authenticated route projection; reuse the existing supervisor/lifecycle without broadening
search policy. P1 owns the Rust boundary, P2 the TypeScript adapters, and P7 the deterministic prompt
preflight/frozen request handoff. Provider sends remain disabled pending trusted endpoint revision,
Guard/consent/budget, SecretBroker and durable dispatch authority. No checks or provider calls.

**2026-10-21 — managed provider follow-up:** P1 reports ContextSelection admission/advance/recovery
and related event/security contracts now present. A Rust provider request record model is underway,
but remains gated on P6's trusted provider route, credential and consent projection plus the exact
ExecutionHost handoff. P6 is queued at the current three-child capacity limit; active owners are
P1/P2/P7. Parent identified and assigned P7 a managed `prepareStep` ordering defect (`nextSequence`
referenced before declaration). Source-only work continues; no checks or provider requests.

P1 has since completed the provider-request OwnerLog record/reducer, exact pin checks, replay
constraints, stable transition IDs, and startup DISPATCHING→UNKNOWN recovery. HostKernel provider
RPC adapters and P6's Core route projection are still missing. P1 is implementing the strict Rust
RPC boundary in parallel but will issue no send authorization until P6's trusted route/SecretRef/
consent inputs are present. No checks have run.

**2026-10-21 — Pi contract mapping and resumed owners:** `docs/research/2026-10-21-pi-codex-harness-decisions.md`
now maps each supplied Pi Durable contract (context, system/tool changes, replay, forks, child tasks,
queue/wake, extensions, compaction, app state, snapshots, analytics, export/catalog/cache) to
HorizonCode owners, architecture sections, event flows and explicit adopt/adapt/defer decisions.
This uses the user's supplied RFC plus local Codex and OMP-like snapshots; it does not claim a fresh
remote review of Earendil Pi or latest upstream Codex.

Whole-phase source owners P1/P6/P8 are active. P8 added
`reserve_managed_ready_task_with_target` in `kernel/src/worker_durable.rs`; P1 must wire its exact
reservation proof/target into `managed_next_schedulable_task`. P1 identified existing
`managed_provider.*` handlers whose request/response shape disagrees with P2's strict nested DTO;
it is reconciling pins and revision while returning no send authority until P6 route facts and the
Guarded ExecutionHost transport exist. P6 is implementing the trusted Core route/credential/consent
projection and must use opaque refs only. No checks or provider calls have run.

**Current contract/source correction (2026-10-21):** the prior note's one-step
`managed_next_schedulable_task` reservation-target wiring is superseded. Because P8's final pin
includes ContextSelection but Core needs the P8 target to compile that selection, P1/P8 are
implementing a staged pre-admission lease: reserve against known authenticated candidate/profile/
scope/resource pins; Core compiles the exact prompt without dispatch on the reserved target; bind
the Rust-validated ContextSelection digest to that same RESERVED lease; then Attempt admission
consumes it without a second reservation. See `arch_V1/37-RUNTIME-SERVICE-LLD.md` §37.22 and
`arch_V1/18-OPERATIONS-RELEASE.md` §18.18. P8 must preserve same-candidate replay and safe recovery
across crashes between stages. P1 owns HostKernel DTOs and provider RPC alignment; P8 owns staged
reservation/target/context-binding persistence; P2/P7 preserve the frozen prepared request.

P6 source now provides `managedRouteProjection` through existing Provider/Auth SecretBroker owners.
It resolves bundled provider routes and emits only route/endpoint/SecretRef/consent/Guard/capability
references; no URL or credential bytes and no dispatch. `credentialLeaseRef` may be null only for
the exact Core anonymous-free eligibility projection, but Rust must independently prove the route
is canonical anonymous/free before any dispatch. Current Rust prepare/begin continue to return
UNAVAILABLE with null send authorization. No checks/provider calls were run. Preserve source-first
hold, repo-only boundary, and mixed user Git state; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P6's full source pass returned a source-only checkpoint with no additional unblocked P6 source
gap; its managed route projection is documented, while P1-dependent guarded transport/credential
write/live Doctor paths and P6 acceptance remain open. The freed slot is now assigned to whole-phase
P2 managed/direct child lifecycle integration, including exact nullable provider route decoders and
the reserve → no-dispatch compile → bind-context ordering. Active implementation owners are P1,
P2, and P8; P7 is next on capacity. No verification commands have run.

## 2026-10-21 — P8 staged lease and whole-phase source audit

P8 source now exposes a two-stage pre-admission reservation in `kernel/src/worker_durable.rs`.
Stage A reserves the exact candidate/worktree under authenticated known pins and stable
idempotency, without inventing a ContextSelection; restart resolution returns the persisted
deadline/root/resource/worktree pins. Stage B binds the actual Rust-validated ContextSelection
digest to that same still-RESERVED lease. Exact replay returns the same stable receipt and does not
append a duplicate bind event; a changed digest conflicts. Stable Stage-A/Stage-B receipts are
separate from the fresh OwnerLog-cursor/pool-bound lease proof. P1 owns HostKernel handler wiring;
P2/P7 own reserve → no-dispatch compile → bind → admission request preservation. P1 and P2 were
sent the exact API/accessor contract.

Whole-phase audit found no additional safe P8-only effectful implementation to enable. Worker
settlement/fan-out/worktree release still require P1 process/effect quiescence and P2 terminal
Attempt/final-revision/verifier evidence. Resource pressure lacks approved lower-watermark/calm
policy and authenticated ingress; cache retirement lacks authenticated retained-generation
callbacks and measured reclaimed bytes; hard OS quotas remain unsupported. RC0/HUP fake inputs
remain `NOT_ATTESTED` without live P1 HostRun and independent P2 verifier evidence. Keep these
paths unavailable. No tests/builds/typechecks/audits/provider calls have run; V1 remains PARTIAL /
NOT VERIFIED / NOT RELEASED. Preserve mixed Git state; no staging, cleanup, remote access or
publication.
## 2026-10-21 16:13 UTC — active continuation handoff

Continue the complete V1 objective. Current active owners are P1 (Guard/ExecutionHost), P2 (managed/direct child lifecycle), and a documentation-only local Pi-like/Codex comparison reviewer. The P3 implementation owner reported no additional independent source change; discovery remains gated by named authority/acceptance dependencies. Preserve the shared dirty tree and do not test, build, typecheck, call providers, publish, or clean up until implementation is complete.

Artifact decision from the parent’s source re-audit: P1 captures terminal bytes immutably through ArtifactStore and returns a typed ArtifactRef with truthful fidelity/digest under the exact live Attempt/source revision. P2 projects it in the settled HostKernel receipt. Public/Core bounded range reads stay restricted to exact refs linked to succeeded verified evidence; internal verifier consumption must remain on the authenticated HostKernel path. This follows §31.17 and §37.22–.24 without expanding public read authority.

The attachment was read in full. C: has 20 GiB free of 454 GiB; repo is 5.4 GiB; one primary worktree. Local Pi-like source is OMP, not Earendil Pi Durable; local Codex is dirty, so neither proves latest upstream. The comparison review is still underway. Overall V1 is PARTIAL / NOT VERIFIED / NOT RELEASED. No tests/builds/typechecks or release operations have run.
## 2026-10-21 16:16 UTC — implementation delta

The local-reference comparison is complete in `docs/research/2026-10-21-pi-codex-harness-decisions.md`; a whole-phase P7 source owner is now active in the released slot. P1 has removed fabricated `artifact_<effect>` and raw terminal output persistence from EffectHost settlement. P2 is implementing bounded ArtifactCapture in HostKernel, exact Attempt/workspace/effect ownership and typed receipt integration; Core's typed artifact decoder already reflects the contract. On failure after possible process dispatch, retain UNKNOWN. Keep public ArtifactRead gated to exact succeeded verified managed evidence.

Active implementation owners: P1, P2, P7. Do not run tests/builds/typechecks before all source implementation is complete. Preserve mixed Git state and repo-only boundaries. Last C: check was 20 GiB free/454 GiB; repository 5.4 GiB; only primary worktree. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:18 UTC — current integration state

P2 has wired HostKernel terminal capture through bounded ArtifactCapture and the typed P1 EffectHost settlement seam. It records exact effect/Attempt/workspace owner refs, separate status vs FULL/SAMPLE capture fidelity, and leaves UNKNOWN on capture/publish/settle failure. P1 removed raw-output BLOB and fabricated artifact IDs. P7 tightened checkpoint target/action validation and corrected the stale reconnect status; its `app.tsx` preview finding is assigned to P2.

Managed-provider ownership is resolved from §14.24/§37.22–24: P2 = Rust durable provider request records/transitions; P1 = Guarded HostKernel authorization and one-use dispatch boundary; P6 = Core fixed-route/SecretBroker/provider adapter transport. Do not enable until connected and accepted. Active source owners remain P1/P2/P7. No tests/builds/typechecks have run. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:19 UTC — P7 handoff; P6 active

P7 source handoff: checkpoint target/action contracts now reject unsafe, duplicate and out-of-selection targets across HTTP/Core/TUI; token footer now uses per-message provenance and no hard-coded USD aggregate. §31.18/§31.21/§37.11 reflect source-only status. Automation invocation, checkpoint capture/restore and artifact reads remain gated. P2's `app.tsx` artifact preview now validates exact ref/range and encoded bounds before decoding.

Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct lifecycle, and P6 provider/settings/Doctor/S1. P7 is source-complete for now, still unverified. Managed-provider ownership remains P2 durable transitions, P1 guarded HostKernel authorization, P6 fixed-route Core/SecretBroker sender. No tests/builds/typechecks or live calls. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:23 UTC — progressive tool discovery and managed message scope

The requested attachment was re-read. Local OpenCode/Codex patterns have been compared to HorizonCode, with decisions recorded in `docs/research/2026-10-21-pi-codex-harness-decisions.md`; this is not an exhaustive read of every upstream file or a latest-remote audit. The available Pi-like source is OMP, and the local Codex snapshot is dirty.

P7 source audit found `tools.search` is explicitly part of the V1 prompt/tool design (§30.18, §33.21; toolset changes apply only at a safe provider-turn boundary per §§14.6/29.8), while current registry/session code has no generation snapshot. P7 owns the starter/deferred catalog projection and request-bound generation; P2 is to persist its exact bounded tool refs in managed ContextSelection. Candidate discovery must honor the selected HarnessProfileV1 and existing profile/permission filters, omit denied/internal tools, and never authorize effects.

Managed child messaging needs an Attempt-bound effective `permissionScopeDigest`. It must be HostKernel-derived from the actual admitted scope, independent of capability ceiling, profile ceiling, and pre-Attempt accepted scope. P1 owns protocol/schema and Guard helper consumption; P2 owns HostKernel mint/persist/recompute and Core projection. Keep managed message dispatch disabled until these match. Owners currently active: P1/P2/P7. No tests/builds/typechecks/provider calls have run; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
**16:24 UTC delta:** P2's HostKernel source now validates the managed toolset manifest and exact harness pin; P7 has the digest algorithm and bounds for Core's mirror. This is not acceptance evidence. P7 must still implement the selected HarnessProfile source/projection and safe next-provider-turn expansion; P2 must retain the source refs in each immutable ContextSelection. P1/P2 managed-message effective permission digest work continues under the ownership split recorded above.
**16:26 UTC delta:** P1 completed the protocol-side strict `permissionScopeDigest` field and canonical digest helper for managed Attempt scope; P2 owns HostKernel mint/recompute/persistence and Core projection. Effective scope binds the concrete sorted admitted capability intersection plus Attempt/profile/Guard provenance, and an empty set represents no authority. Do not reuse the pre-admission profile ceiling digest. No tests/builds/typechecks.
**16:28 UTC integration boundary:** Managed model requests use the existing Core ProviderTransport and SecretBroker lease. HostKernel does not send model requests: it validates the exact trusted route revision, consent and budgets, then returns a one-use permit persisted through PREPARED→DISPATCHING→settled/UNKNOWN. A missing route match or permit keeps sends unavailable. After P7, the next phase slot is P6 provider/settings/Doctor/S1, then P4.
**16:29 UTC owner correction:** P1's message/permission-scope protocol change is a phase-internal handoff, not P1 completion. P1 is resumed as whole-phase owner for its remaining Guard/ExecutionHost source and dependencies. P2 renamed the pre-Attempt worker reservation field to `profile_permission_ceiling_digest`, preserving the distinction from effective Attempt permissions. P6 remains next queued after a current slot opens.
**16:30 UTC delta:** P2 has separated profile-ceiling pins from Attempt effective permissions throughout Stage-A/Stage-B/attached-reservation comparisons; dispatch handoff carries and revalidates the binding's effective digest against current Guard proof. New writes use `profilePermissionCeilingDigest`; old spelling remains decode-only replay compatibility. One accidental host-wide process-table inspection was reported by P1 and stopped immediately; no processes were modified. Continue under repo-only process inspection.
## Current continuation — 2026-10-21 16:32 UTC

The Pi/Codex comparison is a focused local source/contract study in `docs/research/2026-10-21-pi-codex-harness-decisions.md`, not a full upstream checkout audit: `repo_take/oh-my-pi` is the only local Pi-like source and there is no Earendil `pi` checkout; the Codex snapshot is dirty at `14830654c`. The user-provided Pi Durable RFC was mapped to existing HorizonCode owners/contracts. No remote or latest-upstream check was made due the repository-only boundary.

Active whole-phase owners: P2 managed/direct lifecycle, P6 providers/settings/Doctor/S1 and P5 transport integration, and P7 stream/render/artifacts/analytics/automation/rewind. P1 is partial and queued for the next slot. The current P2 managed-message handler supports the guarded journal path for queued mode and still denies managed `follow_up`; implement a distinct managed proof from the live managed provider completion journal or keep that mode unavailable with a precise gap. Do not reuse direct-turn authority. P7's current source adds bounded permission-filtered deferred tool discovery, generation-bound request projection and matching-output rehydration after restart; it is not verified. P6 now owns the real selected-route SecretBroker sender seam; no model/search/network request is authorized by this assignment. No tests/builds/typechecks/audits/provider calls/release/Git operations have run. Preserve mixed Git state; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:36 UTC — current source ownership and P7 handoff

P7 returned source-complete for currently unblocked progressive discovery work, not verified: bounded registry discovery, permission filtering, next-provider-request activation, restart rehydration against current schema digests, managed toolset source refs, and actual harness prompt payload inclusion. Its details and status are in §§30/31/33 and the P7 research/implementation note. Parent review ran only `git diff --check` over these edited P7 paths; it was clean. No tests/builds/typechecks were run.

New live owners: P1 (non-overlapping ExecutionHost/sandbox/Core process and PTY paths), P2 (exclusive HostKernel managed lifecycle and Core managed paths), and P6/P5 (existing provider/SecretBroker transport and web-search integration). P1 must not edit HostKernel while P2 owns it; P2 integrates any P1 HostKernel interface. P2 managed messaging currently supports a guarded queue journal but still denies `follow_up` pending managed-lane completed-turn proof. P6 route reconciliation follows §14.24: HostKernel validates opaque selected route/endpoint revision and returns one-use authorization; the existing Provider owner checks the concrete SDK destination; Auth constructs SecretBroker trusted context from those proofs, never caller data. Parent found the Rust toolset decoder does not recompute P7's `horizon.toolset.v1` generation digest; P2 is resolving before this managed contract is relied upon. No checks/provider activity/release/Git publication; preserve the mixed working tree. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:40 UTC — resume manifest

Current whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct lifecycle, and P7 stream/render/artifact/analytics/automation/rewind. P1's persisted cgroup identity now includes the exact optional Attempt-scope digest and checks it at pre-dispatch, settlement and restart reconciliation; old records without it fail closed. P2's strict managed ContextSelection toolset manifest now includes `harnessRevision`, and Rust recomputes the generation digest from harness identity/revision and sorted capability/schema members, with Core and JSON schema parity. P7 has been resumed for full phase source completion. P6/P5 is queued for a slot: current transport code is no-send preparation only and remains blocked on the pending dual-digest decision plus P2's fresh-begin permit DTO. Managed `follow_up` is fail-closed pending a distinct managed-lane completion/wake proof. P3/P4/P6/P8/P9, cross-phase integration, and release remain outstanding. No validation/provider/release/Git operations ran; preserve mixed repo state and repo-only boundary. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:41 UTC — managed follow-up proof decision

Resolved the P2 design gap from §29.5: provider request settlement does not prove a complete assistant turn because it may end in a tool call. P2 will add an authenticated Rust `managed_provider.complete_turn` owner-log transition tied to the exact latest settled request/assistant/response/usage pins, live Attempt and epoch, and absence of in-flight provider work or unresolved effects. That durable completion will mint the separate one-use follow-up wake proof; queued messages remain non-waking. P7 owns the Core final-assistant boundary in `session/processor.ts`/`session/llm/request.ts` and is coordinating the callback with P2; P2 owns Rust/managed-control. Active whole-phase owners: P2, P6 (source continuation), P7. P1 returned a source checkpoint PARTIAL and must be resumed for remaining gaps/acceptance; P3/P4/P5/P8/P9 and final integration remain open. No tests/builds/typechecks/audits/provider calls/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:42 UTC — P1/P2/P6/P7 orchestration update

P6/P5 returned SOURCE COMPLETE for currently unblocked code, not verified: catalog/settings/offline Doctor/S1 ownership projections and ordered search auth-failure behavior are present; provider and search dispatch remain false-gated. The managed transport scaffold prepares an exact request and transport digest without lease or send. The user decision on whether HostKernel must bind both normalized input and exact SDK transport digests is still pending; this is a concrete blocker for managed sends, while independent P6 source is closed. P1 has resumed whole-phase source audit. P2 and P7 coordinated a distinct `managed_provider.complete_turn` proof because a settled provider step may be an intermediate tool-call response; P7 will invoke the P2-owned strict HostKernel transition only after `handle.process()` returns at the exact final assistant boundary, not on `finish-step`. Active whole-phase owners: P1, P2, P7. No tests/builds/typechecks/audits/provider calls/benchmark/release operations ran.

## 2026-10-21 16:44 UTC — P7 managed final-turn callback

P7 wired the Core callback at the terminal SessionPrompt loop exit, after reloading the persisted assistant entry and confirming final finish, current-user parentage, and no remaining non-orphan tool work. The callback supplies only the assistant entry ID and live managed Attempt authority; ManagedControl uses the retained exact HostKernel settlement receipt pins and fails closed if they are absent or mismatched. This source integration is unverified and cannot produce a usable completion while Guarded managed provider dispatch/settlement remains unavailable. Automation invocation and checkpoint capture/restore remain gated; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:45 UTC — P1 checkpoint and P2/P3/P7 active

P1 returned source-complete for currently unblocked work, not verified. `EffectHost::begin_execution_dispatch` now returns UNAVAILABLE before validation/persistence on non-Linux, and §14.21 records the platform gate. P1's audit found bounded ToolBatch admission, serial receipt/lease handling, fixed Guard-pinned shell execution, and fail-closed unsupported effect origins; HostKernel/P2 authority integration and later adversarial/OS acceptance remain. The freed slot is assigned to full-phase P3 RepoIntel/Discovery source work. P2 is implementing a durable `managed_provider.complete_turn` proof from the latest exact HostKernel SETTLED request; P7 wired the caller only at the persisted terminal runLoop boundary (final assistant, current user parent, no non-orphan tool work). Parent review identified a required restart path for recovering exact settlement pins after `.settle` before `.complete_turn`; P2 is addressing it, otherwise UNKNOWN/unavailable. P6/P5 source is complete for unblocked work, with provider/search still closed pending the user dual-digest answer and Guard/SecretBroker integration. Active owners: P2, P3, P7. No tests/builds/typechecks/audits/provider/benchmark/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 16:51 UTC — continuation handoff

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle, P6 providers/settings/Doctor/S1. P2 owns `kernel/src/host_kernel.rs`, `kernel/src/managed_control.rs`, and managed-control Core paths; P1 owns EffectHost/Guard/sandbox/process/protocol paths and routes HostKernel interface gaps to P2. P6 owns the current Provider/SecretBroker adapter and parse repair at `packages/opencode/src/session/llm.ts:1016`. Parent decision §17.25 requires both normalized Horizon request digest and exact non-secret SDK transport request digest on the same one-use authorization/settlement, bound to selected route revision and managed Attempt/epoch; no provider dispatch is enabled.

The verifier contract is governed by §§12.19/37.22: the coding Attempt remains live while verifier effects execute, using `managed_run` origin with the same Attempt binding, current revision, trusted verifier profile principal, and a distinct authenticated reviewer. P2's separate complete-turn proof gates managed follow-up wake; queue-only inbox messages remain non-waking. P3 returned PARTIAL with lexical discovery present and P1/P4/parser/overlay/P8-trigger dependencies open. P7's terminal callback is source-present, but exact P6 settlement and P1/P2 dispatch are prerequisites; automation/checkpoint mutation remains gated. P4/P5/P8/P9 and integrated final acceptance remain open.

Source comparison provenance was corrected: `repos/codex` and `repo_take/oh-my-pi` are ignored local reference trees; Codex has no local Git identity, so its stated upstream pin is unverified. OMP is not the official Earendil Pi source, and Pi Durable details came from user-provided text. No remote/upstream freshness claim is made. A focused P1 test selector was mistakenly invoked, then stopped on a Bun parse error in the concurrent P6 `llm.ts` before any test body; it was not retried. No checks/provider calls/release/Git operations were otherwise performed. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 17:12 UTC — implementation continuation handoff

Resume full HorizonCode V1 implementation, source first; do not start tests/builds/typechecks yet. Repository-only boundary and mixed Git state remain in force. Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct lifecycle, and P4 LSP/DAP/REPL. P6 is open and must resume when a child slot frees; P3/P7/P8/P9 and final integration remain open. Current child capacity is three agents plus parent; fill each newly freed slot with a whole-phase owner on the critical path.

Latest source deltas: P1 added the distinct verifier `execution_principal` pin through process/cgroup/recovery/receipt paths; P2 is carrying it through HostKernel verifier invocation and receipt projection, with the registered verifier profile principal as process principal and reviewer identity separate. P2 added a managed inbox table/API because the direct inbox cannot represent managed Attempt authority; continue prepare/ACK/recovery and safe-boundary wake. P5 cascade matches the approved auth 4xx/429/transient behavior but runtime remains disabled. P6's triple-digest authorization is Core-side scaffolding; HostKernel/Rust begin, durable settlement, opaque authorization return and the existing Auth/SecretBroker/Provider send path are still incomplete and must remain gated.

Do not declare any phase verified. No tests/builds/typechecks/audits/provider requests/releases/publication/cleanup have occurred in this continuation. Re-read root policy and owning contracts after compaction; coordinate shared APIs without changing exclusive file ownership. The parent maintains shared trackers and performs cross-phase integration.

**17:22 UTC delta:** P4 returned its source pass, including the typed REPL callback read/reply wire and shared canonical MessagePack encoder; the source is Git-visible through an exact `.gitignore` exception. Callback effect ingress remains gated until P1's EffectHost journal, P2's HostKernel route, P3 reader proof, and OS acceptance exist. P7 has resumed as a whole-phase owner and exclusively owns `packages/opencode/src/session/prompt.ts` and `processor.ts` for the separate managed follow-up callback/runner seam and final-turn boundary, plus its listed stream/artifact/UI files. P2 has been told not to edit those files. P6 is next in the queue. No tests/builds/typechecks/audits run.

## Continuation checkpoint — 2026-10-21

Resume source implementation across all V1 phases; do not run verification until implementation freeze. P1's current source pass has returned source-complete only, with unsupported OS/REPL paths still disabled and acceptance open. P2 added an exact one-use wake-claim receipt to context advance and a typed `TaskPromptOps` adapter; P7 owns SessionPrompt injection. P6 is active and owns provider DTO/record/transport integration; P2 retains HostKernel call-site and managed lifecycle ownership. Active child owners: P2, P6, P7. When a slot opens, start whole-phase P3 first, then P4/P8/P9 by dependency/critical path. No tests/builds/typechecks/audits/provider calls/Git publication/cleanup. Repository-only boundary and mixed Git state remain mandatory.

**Continuation delta:** P7 returned source-complete for currently unblocked work, not verified. Follow-up runner plumbing plus replay/render/artifact/analytics/checkpoint foundations are present; automation invocation and restore remain gated. P7 identified a managed wake-claim scope digest mismatch for P2 to resolve. The freed slot is assigned to whole-phase P3 RepoIntel/Discovery. Active owners are P2/P3/P6; no checks or external operations were run. Preserve repo-only boundary and mixed Git state.

**P2 contract delta:** managed scope now carries required BLAKE3 `permissionScopeDigest` and strict BLAKE3 `workspaceRevision`; Core exact-key/identity checks include them. Follow-up uses the persisted one-use claim to build the exact next ContextSelection before context advance; P2 will wire HostKernel call sites once P6 provider DTOs are stable. No checks run.

**Writer ownership correction:** P6 provider request DTO/OwnerLog changes touched P2-owned `session/managed-control.ts` and `kernel/src/managed_control.rs`. P6 has been directed to stop those files and hand off its exact provider hunk; P2 pauses those files while continuing non-overlapping coordinator/HTTP/Task integration. P6 remains on its exclusive LLM/ProviderTransport and P6-only source. Preserve single-writer ownership before continuing shared files.

**P3 source delta:** tree/detect registry wiring now requires the explicit experimental flag, negotiated HostKernel feature, and acceptance readiness; fail-closed constants remain false. The unused Core local RepoIntel node was removed to preserve HostKernel as sole production query owner. P3 documents no-follow discovery revision separately from strict mutation revision. Overlay minting and trusted pressure triggers remain P1/P8-owned dependencies. No checks run.

**P3 handoff:** P3 source pass returned PARTIAL. Registry/readiness wiring is present and closed by default. Open dependencies: P4 immutable unsaved-buffer snapshot producer → P1 private overlay mint; approved parser intake is absent per §42.11; P8 trusted pressure trigger; P1 protected persistent-cache root/restart lifecycle; integrated symlink journey. The slot is now assigned to whole-phase P4 continuation. Active owners P2/P4/P6. No tests/builds/typechecks/audits ran.

**Managed follow-up compiler:** coordinator cannot derive the exact normalized next request body from real child history. Parent authorized P2 a narrow, single-writer `prompt.ts` helper to prepare the exact body without dispatch or transcript mutation, reusing existing Core prompt/runLoop compilation. P7 will review/reconcile on its next slot. Never reuse seq-1 input or fabricate a provider body; keep follow_up unavailable if exact compilation cannot be produced.

**P6 source checkpoint:** provider DTO/OwnerLog pin source and opaque transport matcher are present; dispatch remains gated on P1/P2. Independent Doctor/settings/model/S1 sources are present but unverified. P6 stays open for integration after Guard/HostKernel contracts land. Its slot is assigned to whole-phase P8. Active owners P2/P4/P8; no verification/provider calls.

**Managed follow-up ACK boundary:** P2 is adding an authorized typed post-commit/pre-send callback so exact inbox consume and HostKernel ACK follow durable message creation but precede model dispatch. Any uncertain ACK fails closed; queue/direct paths do not receive the callback. P7 will reconcile the interface later.

**P8 source delta:** worker success now rejects final Inspect that is unattributed or contains user-owned changes at proof creation, live settlement, terminal resolution and replay; failure/cancel remains quarantine-only. No checks run.

**P4 handoff / P1 resumption:** P4 source pass is PARTIAL: callback wire/digest/settlement discriminant is present; HostKernel callback routes, P1 denial-receipt proof, authenticated DAP ingress, unsaved-buffer authority and platform acceptance remain. LSP/REPL stay gated. P1 has resumed to reconcile actual Guard/EffectHost source and the managed provider Guard adapter; P2 still owns HostKernel routes. Active owners P1/P2/P8; no checks ran.

**Provider Guard decision:** add an internal-only canonical `providers.infer` Guard action per §14.24/§17 A-V2-27. Do not reuse `web.search` or broad outbound HTTP. Bind selected route/model/harness, three request digests, Attempt/epoch, explicit consent/budget and one-use permit. Do not expose it as a model tool; arbitrary URLs/fallback remain forbidden. P1 owns its Guard/ExecutionHost path and catalog/contract reconciliation; dispatch stays gated pending P2/P6 and acceptance.

**P2 follow-up source delta:** both managed Task run entry points now receive the typed no-dispatch runner. It claims/persists wake, compiles actual next request, advances context, commits the user message, then consumes/ACKs before provider dispatch. Exact refreshed scope, request, message and digest pins are bound; P2 is finishing crash-after-consume recovery and provider digest echo. Provider dispatch remains unavailable.

**P8 restart-disposition source delta:** the current-epoch fresh-Inspect proof and separate OwnerLog disposition recovery event are source-present, binding settlement pins, root/owner, P2 terminal/quiescence, and current Guard receipt. Historical Inspect cannot release a quarantined lease across epochs. P8 is reconciling pressure/cache/RC0/verifier source and will hand off HostKernel API names. No checks run.

**P8 handoff:** source-complete only for unblocked work, not verified. Cross-epoch success disposition now has a P8 proof/event API requiring current-epoch fresh Guarded Inspect; P1 HostKernel root/owner/quiescence route and P2 terminal snapshot remain. Lease stays quarantined. Pressure/cache/RC0 remain gated; unsupported OS quotas remain unavailable. P9 now owns the free slot for distribution/install/update/rollback source. Active owners P1/P2/P9; no checks/releases/publication.

**P1 provider Guard source delta:** canonical sealed internal `providers.infer` now exists (`kind: action`, not model-callable) with separate prepare/effect bindings and EffectHost prepare→Guard authorize→one-use consume; Guard challenge/lease are host-created, unresolved tokens recover as UNKNOWN. P2 is removing caller-projected authority fields from HostKernel route DTOs. P1 also added the REPL page reader from live supervisor/journal observations. No checks ran.

**P2 follow-up recovery delta:** every managed provider dispatch now checks the exact committed prompt/inbox proof; Core consumption and HostKernel ACK must be durable before `handle.process`. Exact consumed proof only replays; ambiguity blocks dispatch. REPL callback routes remain unavailable pending a sourced interpreter frame codec and IO-sequence semantics.

**P9 source delta:** candidate preparation currently mutates build source after digest, invalidating clean release qualification. P9 is moving the guard to the first-party build script and removing preparer mutation. No build/release action.


## 2026-10-21 18:03 UTC — V1 source implementation continuation

Parent re-read the required bootstrap in order. Repository-only boundary remains absolute; mixed unstaged Git state is preserved. Source-first hold remains: no tests, builds, typechecks, audits, provider calls, release operations, remotes, staging, commits, cleanup, or external paths. Repo-local free space remains ample from the last repository-contained inspection (814 GB available; `kernel/target` 627 MB); no build has run since.

Current whole-phase owners (actual live slots): P1 Guard/ExecutionHost, P2 managed lifecycle, P9 distribution/install readiness. P1 reports the sealed internal `providers.infer` EffectHost prepare/approve/consume/settle/UNKNOWN/recovery source with exact request/route/SecretBroker/Attempt bindings; remaining end-to-end HostKernel/Provider/SecretBroker wiring is P2/P6-owned and gated. P2 owns the HostKernel + `session/managed-control.ts` API/response contract; the next P6 owner must own `session/llm.ts`, ProviderTransport, and provider/SecretBroker send callbacks to avoid shared-file races. P2 continues follow-up, reviewer/verifier/current-revision, P8 settlement integration and REPL fail-closed review. P9 is closing unblocked local source; no candidate build or release action.

Queued whole-phase owners for newly freed slots: P6 first (managed provider sender and remaining provider/settings/Doctor/S1 integration), then P3/P4/P5/P7/P8 as their dependencies and owner slots permit. All phase source remains unverified; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 18:06 UTC — active owner correction and P6/P7 dispatch

P1's unblocked source phase has now returned source-complete (not accepted). P1 reports Guard checks canonical capability membership through P2's `canonical_capability_id_is_registered`; P2 confirmed the implementation helper is `managed_control::canonical_capability_id_is_registered(&str) -> bool`. P1's provider Guard/EffectHost contract is ready for P2/P6 integration; REPL remains unavailable without the authenticated HostKernel route and sourced interpreter frame codec. P9 returned source-complete for unblocked local packaging/audit source, not release accepted.

Freed phase slots were immediately assigned to P6 (existing Provider/SecretBroker sender plus settings/Doctor/S1) and P7 (stream/render/artifact/analytics/automation/rewind). Actual live owners: P2, P6, P7; P2 exclusively owns HostKernel + managed-control files and is correcting stale §17.15/§17.17 ownership notes. P7 is reclaiming its prompt/processor files after reconciling P2's temporary no-dispatch helper. P1/P9 must be resumed by the parent for integrated acceptance after source freeze. Queued P3, P4, P5 and P8 remain open; start whole-phase owners as slots free, based on dependency readiness.

No verification/provider/release/remote/Git mutation has occurred. Mixed working tree preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**18:08 UTC integration finding:** Parent source inspection found the managed provider prepare input still contains caller-projected `guardChallengeID` and `capabilityLeaseDigest` (`ManagedProviderRouteProjectionV1` and the Rust `managed_provider_prepare` serializer/strict response shape). This conflicts with P1's HostKernel/EffectHost contract: HostKernel must create the challenge/effect only after prepare is durably recorded; callers cannot supply challenge or lease authority. P2 owns removing these input fields and exposing the host-minted prepare/approval response, then the post-approval one-use dispatch authorization. P6 will consume the exact new response in the existing Provider/SecretBroker sender. Provider sends remain disabled until P1/P2/P6 integration and final acceptance.


**18:10 UTC P7 continuation:** P2 has handed prompt.ts back to P7; the temporary managed follow-up seam is now P7-owned for reconciliation. P7's full source audit identified missing timezone-aware durable automation scheduling/invocation source and checkpoint capture/restore implementation beyond the existing preview UI/endpoint. P7 is implementing the schedulable/control source while keeping invocation gated until P1/P2 receipts are accepted, and will implement checkpoint lifecycle only where complete same-revision no-follow filesystem/Git observations and Guard routes exist; otherwise restore remains unavailable. P2 retains HostKernel. No tests or builds run.


**P7 source correction, 18:11 UTC:** A parent source search found that the canonical Rust automation already contains timezone-aware schedule fields, due-occurrence logic, missed-run handling, and deduplication in `kernel/src/automation.rs`. Therefore P7's earlier statement that a scheduler model was absent is superseded: P7 will reuse and wire that existing authority, not build a parallel scheduler. The production Guarded invocation boundary may still be missing and remains gated. P7 will also inspect the existing `kernel/src/checkpoint.rs` before changing checkpoint lifecycle source.


**18:13 UTC automation integration finding:** P7's source audit found `AutomationGuardContextV1` currently impersonates `SessionBatch`, which violates §§14.1/14.2; the action invocation also lacks stored/resolvable arguments. The canonical Rust scheduler exists, but effectful invocation still needs a dedicated host-selected `AutomationRun` Guard origin/policy (P1), plus exact HostKernel prepare/begin/settle/reconcile and canonical action resolution (P2). P7 will add only its durable schedule candidate/preview/payload projection and TUI source, leaving invocation unavailable until those contracts arrive. This supersedes no prior scheduler implementation; no duplicate scheduler is authorized.


**18:16 UTC provider authority update:** P2 has removed caller-projected Guard challenge/lease from the managed route projection and split the HostKernel-minted challenge (`prepare`) from approved lease/opaque send authorization (`begin`); OwnerLog no longer records a lease at PREPARED. P6 reports the sender contract is aligned, but HostKernel prepare/begin/settle still return `UNAVAILABLE`, and route consent still needs a trusted source. P2 now owns activating the actual Guard/EffectHost-backed durable lifecycle using P1 interfaces; P6 owns resolving authenticated user consent and the existing Provider/SecretBroker sender. No send is enabled.


**18:19 UTC managed inference consent decision:** Architecture review of §§14.24/.25, 16.17, 37.22/.23 found no accepted separate persistent provider-enable setting for inference routes. Use the exact HostKernel-created Guard approval challenge as per-effect route consent, bound to the selected provider/model/harness/endpoint revision, billing/budget class, live Attempt and request. Do not accept caller `consentRef`, infer consent from credentials, or add another config authority. Existing user-selected provider/model remains authoritative; persistent web-search route enablement stays a distinct setting. P2 is recording the contract in §14.25/§37.23 and implementing OwnerLog approval pins; P6 carries the host-issued challenge proof through the existing Provider/SecretBroker sender.


**Automation scheduler correction (18:22 UTC):** Parent's 18:11 source note was wrong and is superseded. `kernel/src/automation.rs` stores `schedule_expression`/`timezone` and processes externally resolved UTC `DueOccurrenceV1` records; it has no cron/timezone resolver or producer. §31 explicitly says not to add an ad hoc parser. P7 removed its TUI parser/preview. Scheduled execution remains blocked until an accepted canonical timezone-aware Rust scheduler source is available; no external fetch/dependency install is allowed under the repository-only boundary. P7 is documenting this exact limitation and can complete the fixed-input payload/Guarded invocation source, but must keep scheduling unavailable without the resolver. Proposed action inputs are immutable bounded user-authored payloads, versioned with the AutomationDefinition, validated against the canonical action schema at save and dispatch, and digest-bound to Guard approval/receipt; dynamic model args and raw secrets are forbidden.

## 2026-10-21 — managed provider consent-pin unblocker

User renewed the full V1 deadline request. Actual child capacity is three active agents; current whole-phase owners are P2 managed/direct lifecycle, P6 provider/settings/Doctor/S1, and P7 streaming/artifacts/automation/rewind. P1 is queued for the next slot, followed by remaining open P3/P4/P5/P8/P9 work. Parent source review found `ManagedProviderPrepareBindingV1` and `ManagedProviderAuthorizationPinsV1` still required `consent_ref`, contradicting the accepted per-request HostKernel Guard challenge and making prepare circular. Parent removed that field from both Rust DTOs and their validation/digests in `kernel/src/http_execution.rs`; exact route identity and request/Attempt/scope/budget pins remain, while Guard challenge/lease remain post-prepare authorization pins. P2/P6 were notified to align integration; P2 owns corresponding §37 wording. This is a narrow source unblocker, not P1 acceptance. No tests/builds/typechecks/audits/provider calls/release operations ran. Mixed Git state remains preserved, repo-only boundary remains active, and V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**P7 source milestone — 2026-10-21:** Automation definitions now have optional legacy-safe `action_schema_digest` / `action_input_json`, a v2 OwnerLog snapshot migration (v1 loads unbound), 16 KiB canonical object validation and schema/payload digest pinning in the effect intent; Core API/TUI models carry fields but hide payload content. New writes require both values and legacy unbound definitions cannot dispatch. This is incomplete: P2 HostKernel parser/summary/Guard projection still rejects the new shape; P1 must validate schema IDs/digests against the authenticated canonical action registry and enforce secret/opaque-ref policy. Dispatch remains disabled. No tests/builds ran.

**P2/P6 provider approval seam — 2026-10-21:** P2 confirms the existing authenticated approval flow: HostKernel registers the provider Guard challenge in `self.challenges`; TUI calls existing `effects.resolve_approval_set` with `{sessionID,locationID,batchID,challengeIDs:[challengeID]}`; `managed_provider.begin` follows the authenticated user decision and receives no caller-supplied challenge/lease authority. P2 has also updated the HostKernel automation parser/summary to carry P7's `actionSchemaDigest` and `actionInputJSON`; canonical registry validation and execution remain gated on P1. P6's LLM managed path still hard-fails until P2 lands prepare/challenge/begin plus the one-use consume route and settlement. No checks/provider calls ran.

**P1/P2/P6 exact approval blocker — 2026-10-21:** source review found the current managed approval set is verifier-specific: `EffectHost::resolve_managed_run_approval_set` requires `BUILTIN_VERIFIER_ID` and recomputes a verifier-profile Guard decision; TUI decoder/eligibility accepts only `managed_run` + `host.managed_verifier`. P2/P6 cannot use it for `providers.infer` without a trusted P1-owned exact action path. P1 was assigned this whole-phase follow-up when a slot opens: allow only the canonical provider inference challenge with HostKernel-authenticated exact binding, update the strict approval projection/UI eligibility, and hand P2 the exact approval contract. No synthetic allow path is permitted. This is now the top queued critical-path phase; existing three slots remain occupied by P2/P6/P7.

**P7 automation schema trust correction — 2026-10-21:** HostKernel now parses and returns the new action schema/input fields, but no authenticated canonical registry resolver exists. P7 found Core create/update still submitted caller-entered `actionSchemaDigest` to Guarded prepare, contrary to §31.20. P7 is adding a pre-prepare fail-closed gate for create/update; enable/disable/read paths remain available according to existing policy. Parser presence is not schema validation; P1 must supply the authenticated resolver before definitions can be accepted for effectful invocation. No tests ran.

**P6 transport hardening — 2026-10-21:** the existing Provider SDK construction now rejects resolved environment/provider/model credentials for managed routing and uses the selected SDK `languageModel`; prepared request validation also rejects credential-shaped URL query parameters. This remains source-only; managed dispatch is fail-closed until P1 canonical provider action/approval and P2 prepare/begin/consume/settle routes land. No checks ran.

**P6 status-message correction — 2026-10-21:** P6 updated managed LLM fail-closed diagnostics to identify the actual pending Guard approval, one-use HostKernel authorization, bounded SecretBroker transport and settlement/UNKNOWN prerequisites. No gate opened and no checks ran.

**Provider production wiring gap — 2026-10-21:** P6 source search found `settleManagedProviderRequest()` and `markManagedProviderRequestUnknown()` currently have no production call sites; the fresh authorization handle and Auth dispatcher also remain unused behind the managed LLM hard gate. Complete managed provider integration still requires SDK fetch interception through the existing Auth adapter, final persisted assistant-entry/usage settlement, and UNKNOWN marking/recovery. P2/P6 were assigned these exact integration edges. Keep the gate closed until they land; no checks/provider calls ran.

**Provider settlement ownership clarified — 2026-10-21:** P2 owns HostKernel settle/UNKNOWN enforcement; P6 owns existing SDK/Auth request-local transport; P7 owns `prompt.ts`/`processor.ts` orchestration after persisted final assistant entry and exact usage receipt, including UNKNOWN on uncertain send. P7 has requested exact P2 supervisor DTO/signatures before wiring; P6 will prepare its fetch adapter against current pins. Automation create/update now fail closed before `prepareUserEffect` until P1's authenticated schema resolver exists; TUI reports unavailable. No checks ran.

**Provider response digest contract gap — 2026-10-21:** P6 found no defined canonical `responseDigest` formula/source verifier. Parent proposed reuse of the existing strict `SessionMessage.Assistant` schema and `encodeCanonicalMessagePackV1`: BLAKE3 over domain `horizoncode.managed-provider-response-entry.v1\0` plus the exact final persisted Assistant entry bytes, including ID/content/model/finish/usage provenance; derive usageDigest separately via §12 and persist only digests in OwnerLog. P2 must confirm this or point to an existing authoritative transcript digest API and update the LLD/schema before P7 settlement wiring. No response-text reconstruction or dispatch until resolved.

**Provider response digest resolved — 2026-10-21:** P2 confirmed no existing persisted-entry digest API and accepted the proposed contract in §37: `responseDigest = BLAKE3("horizoncode.managed-provider-response-entry.v1\\0" || encodeCanonicalMessagePackV1(schema-decoded exact persisted Assistant row))`, binding ID/content/provider/model/finish/UsageProvenance. `usageDigest` remains the separate §12 canonical-JSON usage receipt. HostKernel binds authenticated Core's exact persisted-entry receipt to live DISPATCHING OwnerLog; it does not claim an independent transcript reader. P7 has the exact contract and may proceed. No tests ran.

**Managed provider route authority gap — 2026-10-21:** parent source review confirms HostKernel currently compares provider/model to Task-pinned AgentProfileV2 but accepts harness/route/endpoint revision/credential ref only as the caller's projection. P2 recorded that these facts need admission-time resolution from existing Core Config and a secret-free immutable Attempt route pin/digest; prepare/begin must compare exact pins. P6 is identifying the current canonical Core provider resolver/DTO. No second registry may be introduced; until that source exists and exact pinning lands, managed route dispatch stays unavailable. This extends the critical P1/P2/P6 gate.

**Provider route resolver identified — 2026-10-21:** P6 found the canonical existing source: `Provider.managedRouteProjection({providerID,modelID,harnessID})` from `Provider.Service.list()` plus Auth metadata-only SecretBroker refs. It derives route ID and endpoint revision from provider/model/SDK adapter identity and canonical endpoint URL; `managedRouteTransportTarget` re-resolves and compares endpoint revision before constructing the SDK model. No separate provider-config revision API exists. P2/P6 are pinning the six-field secret-free DTO (`providerID`, `modelID`, `harnessID`, `routeID`, `endpointRevision`, `credentialLeaseRef`) at managed Attempt admission from Task-pinned AgentProfileV2 and requiring exact equality on each request. No second registry; dispatch remains gated.

## 2026-10-21 — quota recovery and active phase roster

The requested attachment was read. It restates the local-source-first OpenCode/Codex comparison, full V1, whole-phase implementation and source-before-tests requirements; the repository-local comparison/adapt/defer record is `docs/research/2026-10-21-pi-codex-harness-decisions.md`. Prior P2/P6/P7 child invocations reached their usage limit; P1/P2/P7 have been relaunched as the three actual whole-phase owners. P6 remains open and queued to resume first when a slot frees. P3/P4/P5/P8/P9 remain open and queued by dependencies/critical path. Parent is coordinating route pins, approval and settlement interfaces; P1/P2/P7 have non-overlapping owned source scopes. No tests/builds/typechecks/audits/provider calls/release/Git publication ran. Repository-only boundary remains, mixed Git state is preserved, and V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**P1 provider approval API source milestone — 2026-10-21:** P1 reports a dedicated `providers.infer` managed-run approval resolver is now source-present in EffectHost. Its exact UI projection is `origin=managed_run`, `source=host.managed_provider`, capability/action `providers.infer`, policy `provider-inference.managed.v1`, exact nonempty requested-guarantee set for live Attempt/route revision/all three digests/explicit consent/budget/one-use/no fallback, assessed residual empty, and allow enabled only with complete host facts. UI targets contain only nonsecret provider/model/route/revision. P2 owns HostKernel capability-specific source mapping and challenge registration; no verifier/root borrowing. P1 is sending the exact resolver signature to P2. Source-only, no checks.

## 2026-10-21 19:08 UTC — current source handoff

Full V1 remains the target. Active whole-phase owners are P1, P2 and P7 (three actual child slots). P1 reports exact `providers.infer` approval resolver/UI source landed; P2 must complete HostKernel challenge registration/mapping and managed provider begin/consume/settle; P7 is deriving the response digest from schema-decoded persisted Assistant entry plus exact indexed step-finish usage, failing closed on ambiguity. P6 remains first queued; P3/P4/P5/P8/P9 and integrated acceptance/release remain open. No tests/builds/typechecks/audits/provider probes/release/Git mutation ran. The user’s implementation-first hold, repo-only boundary and mixed-tree preservation remain in force. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 19:12 UTC — provider multi-step contract:** Keep tool-capable managed inference. Each actual provider dispatch gets its own monotonic Attempt sequence/request ID; persist exact indexed step-finish + current Assistant snapshot, settle before effects/next dispatch, and digest the point-in-time canonical snapshot. Later message parts cannot alter that receipt. Usage digest remains distinct. HostKernel receipts are per dispatch; turn completion binds final assistant plus ordered dispatch settlements. §37.22 and §45.8 updated. P2 owns HostKernel/OwnerLog, P7 owns persisted Core projection. No checks ran; all dispatch stays gated.

The inherited upstream StepFinishPart schema lacks the persisted HorizonCode `stepFinishIndex`/`usageProvenance`; P7 must add a strict first-party versioned projection and leave the pinned upstream schema untouched.

**19:15 UTC:** P1 returned a PARTIAL whole-phase source handoff and retains integration-regression responsibility. Its slot was immediately assigned to P6; current active owners are P2/P6/P7. P6 owns provider/catalog/settings/offline Doctor/S1 outside P7's Session LLM/processor callsites and P2's managed-control/HostKernel. Missing authenticated grants keep effectful provider/SecretBroker/Doctor/automation paths disabled. P3/P4/P5/P8/P9 and final integration remain open. No checks/provider calls/release/Git mutation.

**Managed ToolBatch ordering:** buffered tool-call/finish parts mean processor's ordinary step-finish handler is too late to settle before Guard. P7 now owns a narrow ToolBatch callback DTO/callsite seam to persist validated pending calls + indexed finish snapshot, settle, then permit Guard; later stream events must reconcile idempotently. P1 admission logic is unchanged. Keep managed effects disabled if persistence-before-Guard ordering is not source-safe. This supersedes the earlier ordering assumption; no tests ran.

**19:28 UTC:** P7 has a strict first-party step-finish projection and v2 per-dispatch receipt adapter; P2 is adding matching `stepFinishIndex` durable pins. ToolBatch buffers finish/tool-call events, so P7 owns a narrow callback seam to persist and settle validated calls before Guard, then reconcile buffered events idempotently. P2 is wiring HostKernel prepare/approval/consume; begin remains disabled pending exact lease + SecretBroker context binding. P6 is repairing only the anonymous OpenCode route and awaits P2's exact RPC DTO for Auth/UNKNOWN. No validation/provider calls.

P7's two new persisted-step receipt files were hidden by root overlay ignores; narrow exceptions were added to `.gitignore` and the exact files are now Git-visible, unstaged.

P6's Auth consume/UNKNOWN adapter now carries exact route/request and challenge/effect/lease/binding pins plus fresh retained SecretUseContext; P2 must echo/mint the matching fresh begin binding. Source-only, no check/provider call.

## Architecture freeze handoff — 2026-10-21

Full line coverage of all 47 `arch_V1/*.md` files is complete; affected HLD/LLD, flows/events, schema definitions/contracts, test catalog, UI/Settings, governance, provenance and release dependencies have been reconciled. Primary-source external research supports the selective design choices recorded in `arch_V1/17-GOVERNANCE-DECISIONS.md`, `arch_V1/14-EFFECTS-EXECUTION-SECURITY.md`, `arch_V1/37-RUNTIME-SERVICE-LLD.md`, `arch_V1/12-DOMAIN-SCHEMAS.md`, `arch_V1/03-FLOWS.md`, `arch_V1/04-STATE-EVENTS.md`, `arch_V1/16-UX-SETTINGS-ECOSYSTEM.md`, `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md`, `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md`, and `arch_V1/45-V1-EVENT-FLOWS-ATLAS.md`.

Key settled contracts: low-friction direct coding uses a distinct explicit, principal/location/backend/policy-pinned DirectSessionGrant with expiry and revocation; safe workspace operations stop prompting after grant while Guard/ExecutionHost and receipts remain mandatory. CodeMode reuses the existing interpreter and authorized catalog, executes no ambient authority, admits bounded <=32-call waves (<=64 total) through ordinary ToolBatch Guard and stops on UNKNOWN. Search model input is query intent only; HostKernel resolves a trusted route plan; four initial keyless routes plus six separately enabled auth routes produce max 10 profiles / 20 route attempts, one ordered cascade pass and route-local bounded retries. ContextService and ContextLedger are V1; snapcompact is deferred.

Static contract evidence from the schema owner: 52 JSON documents parsed; 50 schemas/OpenAPI Draft 2020-12 checks passed; 793 `$ref`s resolve; safe JSON integer bounds and DecimalU64 edge cases passed; `git diff --check` passed. These are not product tests or integration evidence. Known code gaps: CodeMode registry/adapter still fail closed; direct-session grants are design-only; web-search TS/runtime projections need the new route-plan and per-attempt identity/digest fields, 20-entry cap and valid route index bound. Do not enable those capabilities until whole-phase integration and acceptance.

Resume implementation immediately: P1 Guard/ExecutionHost, P2 managed vertical, and P5 built-in web search/CodeMode are first whole-phase owners; queue P6 providers/settings/Doctor/S1 for the first free slot, then P3/P4/P7/P8/P9 by dependency and available capacity. Keep source edits exclusive by phase; P2 owns HostKernel/managed-control, P5 search/CodeMode files, P1 Rust Guard/ExecutionHost. P6 must avoid P2/P7 owned managed provider sender/settlement callsites until those owners release exact interfaces. Do not run product tests/builds/typechecks/provider calls until implementation closes. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Keep all work and temporary artifacts inside this repository; preserve the mixed dirty tree; do not stage, commit, push or prune unrelated state.

### Full V1 phase ledger after architecture freeze

- **P0 direct coding:** source-wired Core V2 session route; parent must verify direct/managed parity and a real selected free model coding journey.
- **P1:** active Guard/ExecutionHost owner; complete confinement, every origin, CodeMode admission seam, atomic ToolBatch, leases/receipts/UNKNOWN/restart; later full adversarial and Linux OS acceptance.
- **P2:** active managed vertical owner; complete reviewer/verifier/effect lease/current-workspace evidence/TUI delivery and pause/cancel/restart/UNKNOWN/conflict; P1 Guard + P6/P7 provider settlement are dependencies.
- **P3:** queued RepoIntel/discovery and authenticated manifest; P1 read Guard and P8 store/retention are dependencies.
- **P4:** queued supervised LSP/DAP/REPL; P1 confinement and P3 source revisions required.
- **P5:** active search + existing CodeMode integration; fixed route plan and Guarded multiwave contracts; depends on P1/P2 shared RPC seams.
- **P6:** queued next; existing provider/SecretBroker sender, settings, Doctor, S1 and TUI switching; dependencies P1/P2/P7.
- **P7:** queued; streaming/rendering/replay, artifact truth, analytics, Rust-owned automation, checkpoint/rewind; effectful portions need P1/P2/P8.
- **P8:** queued; worker settlement/recovery, truthful resource limits, real paired coding-evaluation harness; depends on P1/P2.
- **P9:** queued; distro/install/rollback/candidate/release; final only after phase acceptance and full gate.

Source implementation only is active. The user explicitly deferred tests; no product tests/builds/typechecks/provider journeys have run. At implementation completion the parent must execute final integrated verification, real journeys, adversarial/recovery checks, release gate and exact candidate checks before any VERIFIED/RELEASED claim. Repository-only boundary currently forbids remotes/publication.

**DirectSessionGrant implementation seam added 2026-10-21:** the architecture now specifies authenticated Core→HostKernel issuance/revocation from explicit TUI choices, with all authority pins derived out-of-body by HostKernel and immutable grant digest recomputed/persisted by P1 Rust Guard authority. A grant decision never dispatches the challenged effect; Core re-prepares under fresh workspace state and Guard admits normally. P1 owns `guard.rs`/`effect_host.rs`/ExecutionHost and its private DTO; P2 owns `host_kernel.rs`/`http_execution.rs`/`managed_control.rs` and Core/TUI callbacks. P1/P2 must coordinate signatures without cross-editing. Event projection `DirectSessionGrantChangedV1` is schema-defined and non-authoritative.

## 2026-10-22 — V1 continuation and search contract correction

P1/P2/P5 are the active full-phase owners. P1 source added private EffectHost CodeMode run/wave APIs; P2 is wiring HostKernel lifecycle and existing managed work; P5 is implementing strict TS lifecycle codecs plus search. The shared CodeMode API is start/next-frame/bind-wave/submit-wave-result/cancel; next returns the wave request and ordinary ToolBatch pins, while HostKernel derives identities and receipts from durable state. Keep the registry gate closed until authenticated Core↔HostKernel transport is wired and each wave is Guard-admitted with receipt/UNKNOWN fencing. Corrected §12.9's route-attempt bound from 22 to canonical 20. No product checks or provider calls ran. Next slots: P6, then P4/P7/P8/P9 and P3 remaining work. Preserve the mixed tree; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 07:58 UTC — CodeMode authority and digest seam

Root direct-session CodeMode has no Attempt; managed CodeMode does. P1 is replacing mandatory `EffectAttemptScopeV1` with explicit `DirectSession`/`ManagedAttempt` private authority. Direct root nested calls use ordinary SessionBatch Guard; direct-turn scope appears only for a real child Attempt. §37.24 and the worker-message schema now encode this and forbid synthetic Attempts. Public helper-wave digest is HostKernel-derived from ordered durable `(callId, receiptRef, receiptDigest)` rows and independently checked by Core; Rust's private batch/call/effect receipt digest remains separate and is recomputed for EffectHost settlement. P2 owns HostKernel, P5 the codec, P1 the private EffectHost path. P2 also reports managed independent verifier ingress is still explicitly disabled; it remains a critical P2 gap, with no gate changes. No checks ran.

## 2026-10-22 — External editor design handoff

DEC-V1-33 now includes user-configured editor profiles for CLI/TUI prompt and explicit
workspace-file editing. Terminal editors use a foreground PTY; GUI CLI profiles must
wait for close. No shell parsing, direct Core spawn, or model-selected launch fields.
Added schema `external-editor-profile-v1.schema.json`, `editor.launch`, and contracts in
§§4.17/12.22/14.27/16.20/32.44/37.28. This is documentation/schema work only: current
`openEditor` still returns unavailable. P1 owns process guard/confinement/receipts, P2
owns HostKernel lifecycle, and parent owns remaining Core/TUI integration. No tests ran.
## 2026-10-22 — current continuation handoff

Continue whole-phase source work with P1 Guard/ExecutionHost, P2 managed HostKernel, and P5 web search/CodeMode; all three are active. Parent owns P4/Core prompt integration, cross-phase reconciliation and these tracker updates. Do not run validation/provider calls until implementation work is complete. User-requested permission UX is now Codex-inspired but Horizon-owned: independent sandbox + approval controls; default `workspace-write`/`on-request`; explicit per-Session `danger-full-access`/`never`; no routine in-workspace prompts; no Guard/receipt bypass; managed Runs and paid-route consent remain separate. Parent updated DEC-V1-28 and §§03/04/12/14/16/17/32/37/42 plus the mode schema. P1/P2 must implement HostKernel-authenticated projection + EffectHost admission API; P6 Settings/TUI runtime remains unassigned until a child slot opens.

Explorer/editor facts: no general workspace Explorer pane; Git diff tree exists. `repo_tree`/`repo_detect` adapters are source-present but hard-gated in ToolRegistry pending P1/P3 acceptance. TUI prompt editing exists; external `$EDITOR` launch returns unavailable. LSP supervised client source exists and direct root workspace snapshot was connected, but unsaved-buffer ingress, parser-backed navigation, guarded code actions/rename, DAP runtime, and REPL remain unavailable. No tests/builds/typechecks/audits/provider probes run. Repo-only filesystem boundary holds; mixed Git state remains unstaged and preserved. Release remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-22 — Explorer/editor default visibility clarification

The user directed an opt-in CLI/TUI layout: single pane at startup; no Explorer/editor
panel, persistent sidebar, or always-visible external-editor control. `/editor` opens the
Explorer as an overlay; `/editor --side` opts into a right-side pane for that session.
Selecting a file and choosing Open uses the configured profile, changed through
`/settings` → Editors. Prompt scratch editing also lives inside `/editor`. The design is
recorded in DEC-V1-33 and §§16.2/16.3/16.20, 20.14, 32.44, 33.5, 37.28 and 45.28. Runtime
remains unavailable until Guarded launch, HostKernel/Core integration, and acceptance are
complete; no tests/builds run. Preserve mixed Git state.

P4 continuation: `/root/p4_lsp_editor_ui` is active for the complete P4 phase and the
P4-owned TUI command/layout integration, with exclusive write scope in `packages/tui/**`
and `packages/opencode/src/{lsp,dap,repl}/**` plus matching tests. The UX is fixed by
DEC-V1-33; no extra UI surface may appear by default. Source implementation remains under
the no-tests hold. P2 must not edit P8 worker/resource files. DEC-V1-34 records competitive
software-engineering capability as HorizonCode's primary product objective, measured with
matched reproducible coding tasks rather than unsupported superiority claims.

## 2026-10-22 — P2 partial handoff; P6 active

P2 added source for authenticated per-Session permission-mode snapshot/CAS through
Core SessionSupervisor and HostKernel, pins mode digest/revision into direct terminal
consent and selects Full Access only for `danger-full-access + never`. Exact source is in
`packages/core/src/session/supervisor.ts` and `kernel/src/host_kernel.rs`; fixtures are
unrun. P2 remains PARTIAL: independent managed verifier and aggregate DAG settlement,
CodeMode fixed helper/enablement, and the guarded external-editor lifecycle remain open.
P2 did not touch P8 worker/resource files. A freed slot was assigned to whole-phase P6
providers/settings/Doctor/S1; it must use these APIs but keep provider routes gated until
P1/P2 acceptance. Active owners: P1, P4, P6. No validation or provider activity ran.

**P4/P6 TUI file ownership:** P4 owns `packages/tui/src/app.tsx`, `packages/tui/src/editor.ts`, prompt and session Explorer/layout integration, plus LSP/DAP/REPL modules/tests. P6 owns provider and permission/settings dialog components, settings contexts/components/tests, and provider/auth/config/Doctor/S1 modules. P6 exposes a component/API; P4 wires it through slash-command routing. No shared-file edits without explicit coordination.

## 2026-10-22 — live continuation roster

The active whole-phase owners are `/root/p1_guardv1`, `/root/p4_lsp_editor_ui`,
and `/root/p6_provider_settings` (three child slots occupied). P1 is integrating
the private EffectHost CodeMode wave API and adding the missing non-runnable Rust
editor process identity foundation; HostKernel launch and trusted consent remain
P2-owned. P4 is implementing the command-only Explorer/editor layout while
keeping authenticated file selection and external launch gated. P6 continues
provider/auth/catalog/settings/Doctor/S1. P2 handed off PARTIAL and is next to be
restarted for its whole phase when capacity frees. P5's PARTIAL handoff remains
open; P3/P7/P8/P9 remain queued for whole-phase implementation.

Do not run tests, builds, typechecks, audits, benchmarks, provider probes, or
release checks until the user releases the implementation-first hold. Preserve
the mixed unstaged Git state and repository-only filesystem boundary. V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.

**P4/P6 source progress (2026-10-22):** P4 has implemented the single-pane,
slash-command-only Explorer/editor surface and removed alternative TUI editor
launch callsites, but keeps Explorer selection and editor dispatch unavailable
until the authenticated HostKernel projection and Guarded launch exist. LSP
runtime gates remain false; DAP/REPL remain unavailable pending P1/P3 acceptance.
P6 is wiring authenticated permission-mode settings via ServerAuth, SDK methods,
and `/permissions`; Editors settings remain informational/fail-closed pending
P2's external profile projection. This is source progress only; no checks ran.

**P1 editor process-boundary delta (2026-10-22):** Rust Guard now has a distinct
`EDITOR_LAUNCH_ID` broker action/policy and `ExternalEditor` process-ref kind,
with exact profile/argv/mode/process-tree/fence/one-use pins through the existing
ExecutionHost classifier. This remains non-runnable: no profile parser, PTY
handoff, Full Access supervisor, or HostKernel lifecycle. P2 must implement the
trusted profile resolution and lifecycle; P4/P6 own UI/Core projection. Fixture
is unrun under the testing hold.

## 2026-10-22 — P6 handoff and P2 phase refill

P6 handed off SOURCE COMPLETE for currently unblocked implementation, not
verified. It added authenticated permission-mode Config/SDK/TUI, RepoIntel
settings projection, offline Provider Doctor and owner-scoped QuestionV2/SSE
source. Credential mutation/credentialed dispatch remain gated on P1 protected
write/receipt and integrated P1/P2 transport. Exact first-party ignore exceptions
for the newly added permission/editor/RepoIntel components and mode schema were
added by the parent. P4 owns settings-route mounting.

The freed child slot was immediately assigned to whole-phase P2
`/root/p2_managed_hostkernel`. Current active owners are P1/P2/P4. P2 is accountable
for HostKernel managed verifier/DAG/recovery, CodeMode lifecycle and external
editor resolution; it coordinates Rust DTO seams with P1. P5 remains partial and
open; P3/P7/P8/P9 remain required. Testing/provider/release holds remain active.

**P2/P4 continuation deltas (2026-10-22):** P2 confirms planned-run start,
managed plan/TUI projection, coordinator and substantial verifier challenge/
settlement source are present; `TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false` still
gates approval, dispatch and finalization. P2 is wiring the HostKernel CodeMode
lifecycle to P1's private EffectHost APIs, adding ExternalEditor profile/launch
resolution, and closing managed verifier artifact/caller seams while keeping
prerequisite gates closed.

P4 is authorized to add a gated `tool/dap.ts` and make only DAP registration/
readiness edits in `tool/registry.ts`, using canonical DAP capability IDs and
existing DAP/supervised adapters. It must preserve false gates until Guard and
HostKernel acceptance, and leave websearch/CodeMode registry areas for P5. P2
owns HostKernel DAP routes. No validation ran.

**P1/P4 integration update (2026-10-22):** P1 sent P2 the existing
`prepare_external_editor` supervisor interface and exact CodeMode EffectHost
lifecycle names. P4 added a dedicated `tool/dap.ts` and DAP-only registry entry
using canonical `debug.start`, profile-ID input, typed unavailable response,
and false readiness/Guard route gates. No DAP effect is runnable. P2 must provide
authenticated profile/scope/Attempt/lease lifecycle; the adapter must not mint
random caller IDs. P5 owns other registry regions and must preserve P4's DAP
hunks when it resumes. No checks ran.

**P2/P4 caller provenance update (2026-10-22):** P4's supervised DAP factory
now requires bounded caller-supplied `userActionID` and `callID`; it cannot invent
authority IDs. P2 owns the authenticated source for those IDs and HostKernel
resolution. P1/P2 are coordinating `ExternalEditorLaunchBindingV1`, with Session/
Attempt identity, owner epoch/generation, userAction/call, profile and executable
digests, workspace/revision/file preimage, permission mode, challenge/effect/
lease, and process-generation bindings. The DAP route remains disabled.

## 2026-10-22 — P4 handoff; P5 restarted

P4 returned source-partial: single-pane command-only `/editor`, explicit
`--side`/`--close`, P6 Settings mounts, and gated DAP tool (`debug.start`) with
no fabricated caller IDs are source-present. Authenticated Explorer selection,
external launch and LSP/DAP/REPL journeys remain P1/P2/P3/OS dependencies.

P5 has resumed as a full-phase owner (`/root/p5_search_codemode`) for search and
CodeMode source. It must preserve the P4 DAP-only registry hunks and coordinate
with active P1/P2 on CodeMode authority/receipt lifecycle and search consent.
Active owners: P1/P2/P5. P6 source handoff is complete for currently unblocked
work; P3/P7/P8/P9 remain open. No validation/provider/release operations ran.

**P1/P2 single process authority decision (2026-10-22):** P1 owns the sole
EffectHost/ExecutionHost journal for ExternalEditor prepare/begin/settle/UNKNOWN
and the fixed CodeMode helper executable/entrypoint/package digest resolver. P2
owns authenticated HostKernel authority mint/revalidation, Session/Attempt pins,
RPC and projections that consume those APIs; no parallel HostKernel receipt
store. P5 implements strict TS caller/codecs against these exact contracts and
coordinates package entrypoint identity with P1/P9. Gates remain closed.

**P5 Settings owner:** P5 owns the web-search-specific settings component and
config route/API (`dialog-websearch-settings.tsx`, websearch handler/group).
P4 owns only command/Settings chooser mounting. P5 should coordinate the
component export with P4, and implement route toggles/order plus distinct query-
sharing/cost consent, with no silent billing/auth upgrade. Search remains
runtime-gated until P1/P2 integration.

**P5 Settings correction:** `dialog-websearch-settings.tsx` already supplies route
order/toggles, separate query-sharing and BYO auth/cost consent/revocation, and
local-only status through generic Config get/update; `/websearch/providers` is
read-only. P5 should preserve/reconcile this existing implementation and add
no route absent a specific contract gap. P4 owns the mount only.

**P1/P5 journal/code-mode update (2026-10-22):** P1 found ExternalEditor
EffectHost journaling incomplete (missing receipt and binding digest outputs plus
a `DecisionKindV1` typo) and is repairing before publishing the HostKernel DTO.
P1 then owns fixed CodeMode helper resolution and the remaining invariant pass.
P1 accepted P5's terminal rejected/cancelled CodeMode wave behavior; UNKNOWN
suppresses completion. No tests ran.


**2026-10-22 — continuation:** P5 found a CodeMode integration gap: its current definition projection is MCP-only, but §37.24 requires exact authorized current tool definitions and dispatch through ordinary ToolBatch. P5 owns the registry projection and independent search source; the reusable nested batch adapter is P7-owned in `session/tool-batch.ts`. Do not call tool implementations directly or add a parallel dispatch path. Keep CodeMode hidden until P7 wires the typed adapter and the integrated P1/P2/P5 transport/receipt path is accepted. Active whole-phase owners: P1/P2/P5. Queue P3 first when a slot frees; P7 next as capacity permits. No validation/provider/release commands under the user hold. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**2026-10-22 — P2 managed DAG source gap:** P2 found run-plan admission was still functionally single-Task: roots were not made ready by `StartPlannedRun`, dependency readiness relied on disabled `mark_task_ready`, and concurrent workers could mutate one shared workspace. P2 is implementing Rust-derived root/dependency readiness and single-writer admission until distinct authenticated workspace leases exist, plus verifier support for prior verified Tasks alongside one current pending/live Task. Parent asked P2 to reconcile exact §11/DEC-V1-31 fan-out scope and use existing worktree leases for any required independent workers; serialized behavior must not be reported as parallel fan-out acceptance. P2 also found the fixed CodeMode helper still needs a normative owner-only package manifest path; P9 owns packaging and P1 is adding helper-digest authority. All gates remain closed. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**2026-10-22 — P5 CodeMode source delta:** `tool/code-mode.ts` now removes the old Core-side MCP interpreter/dispatcher and defines an immutable `CodeModeToolContextV1`, strict effective-tool projection, recursive CodeMode exclusion, and a required typed `dispatchWave` callback carrying the exact P2 HostKernel batch projection. Runtime stays unavailable when helper readiness or this context is missing. Parent source review confirmed the catalog must come from the post-filter/post-transform `SessionTools.resolve` active definitions, not raw ToolRegistry/MCP data. P7 owns supplying that exact projection and wiring the callback through ordinary ToolBatch. P5 continues search implementation and TS caller/package integration. No validation or provider/network action ran; all CodeMode/search effect paths remain gated until integrated acceptance.


**2026-10-22 — P1 CodeMode confinement source:** P1 reports CodeMode launch construction now binds only the fixed verified packaged helper (`horizoncode:codemode:bun`), fixed Bun `run <entrypoint>`, a read-only package mount, and no workspace/environment mount. EffectHost now returns the editor binding digest and terminal receipt, while CodeMode terminal reject/cancel/UNKNOWN semantics fence later waves/completion correctly. P1 is adding helper SHA-256 to persisted authority. No checks ran. P2/P9 must supply the trusted owner-only package manifest; no path or entrypoint may come from RPC/Core/model input. Exposure stays unavailable unless cgroup-v2 memory/CPU/PID and RLIMIT_NOFILE controls are each enforced and verified before first instruction, per DEC-V1-29/§37.24.

## 2026-10-22 continuation — source implementation roster

This checkpoint is source-only. Active whole-phase owners are P3 RepoIntel, P5 web search/CodeMode, and P7 streaming/artifacts/analytics/automation/rewind. P3 owns the authenticated RepoIntel schema/code consistency repair through `§12.18`/`§37.4`; P7 owns the shared ToolBatch CodeMode context/dispatcher seam. P1 and P2 are not active: resumption failed because the collaboration service reports its thread limit. Their Guard/ExecutionHost and HostKernel/managed lifecycle work remains critical-path and unfinished. P4/P6 are partial handoffs; P8/P9 are open. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks have run after this source update. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**CodeMode zero-call contract repair (2026-10-22):** The contract allows pure computation with `tools=[]`. Parent changed only `codemode-worker-message-v1.schema.json` start-tool minimum from 1 to 0; P5 aligned TypeScript source. Rust still has a stale `frame.tools.is_empty()` rejection in `kernel/src/codemode_protocol.rs`; P1 was notified to remove that rejection while retaining all canonical digest and bounds checks. This source fix does not enable CodeMode or establish acceptance.

**Search retry contract (2026-10-22):** User chose bounded retry on positive pre-dispatch proof. DEC-V1-26 and §§12/37 now require durable `NOT_DISPATCHED` with no response metadata, one same-route retry maximum; HTTP 408/425/5xx retry once only after durable response receipt; possible-send ambiguity is UNKNOWN/no retry. Updated schemas include the exact nullable HTTP/no-body receipt and public route statuses. P1/P2/P5/P6 own implementation of Rust receipt, HostKernel cursor, TS cascade and ProviderTransport classification respectively. No acceptance or runtime enablement is implied.

**P3 bounded History SQL correction (2026-10-22; source only):** `history.search`
projects each Part's serialized byte length before selecting bounded text.
`history.read_range` now does the same in two stages: a size-only query returns an
explicit oversized result above 65,536 encoded bytes; only a second exact-key query
with the same byte cap selects the requested SQL substring. The second query
rechecks serialized length and returns unavailable if the row changed or disappeared.
The tool surfaces oversized and unavailable separately. §30.12 now records this
behavior. No test/build/typecheck was run. Remaining P3 blockers are integrated
RepoIntel/discovery/cursor acceptance; parser provenance; trusted immutable
editor-buffer overlay ingress; P1-owned protected HostKernel cache/restart/retirement
lifecycle and P8 pressure trigger; direct context-selection caller and P2 managed
lane/profile producer/recovery pins; and integrated ContextLedger streaming through
P7. Dependent exposure remains gated; P3 is PARTIAL / NOT VERIFIED.


## 2026-10-22 — P7 whole-phase source checkpoint

P7 returns PARTIAL so the parent can refill the slot with critical-path P2.
Unblocked source completed: bounded/redacted activity rendering and stream
replay/resnapshot fencing; artifact fidelity/render/resource bounds and bounded
provenance-aware usage analytics; ephemeral managed `session.context_ledger`
projection plus TUI context-bar rendering (48 KiB event bound, request and
source-generation fencing, no raw provider params, best-effort publication); and
authenticated read-only artifact/checkpoint preview adapters. Added explicit
`lane:"managed"` to `compileManagedContextSelection`.

Remaining P7 integration is dependency-gated: P2 authenticated CodeMode wave
source and durable nested settlement; direct ContextLedger exact selection and
profile pins; P1/P2 guarded automation invocation and checkpoint capture/restore
with partial-restore recovery; and authenticated direct artifact-search
provenance. The P5-owned exported CodeMode binder was intentionally left intact;
there is no production caller binding it, and CodeMode stays unavailable until
P2 supplies the authenticated source. No tests/builds/typechecks/audits/provider
calls/benchmarks/release checks ran. P7 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 — current source-only continuation:** Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, and P6 providers/settings/Doctor/S1. P5 returned PARTIAL after completing its currently unblocked search/CodeMode source. Both HostKernel MCP search dispatch sites now call P1's proof-aware whole-handshake API; P2 is completing the keyless/resume outcome path. P1's terminal aggregate receipt now takes the HostKernel digest of canonical MessagePack of the exact approved ordered routes array, including attempt counts, and compares it with the bound request digest; route IDs only validate settled receipt order. Parent corrected §37.5 recovery prose for FAILED/CANCELLED/EXHAUSTED. No tests/builds/typechecks/audits/provider probes/benchmarks/release checks ran. Git remains mixed and unstaged. P1–P9 and final acceptance remain in V1 scope; PARTIAL / NOT VERIFIED / NOT RELEASED.

**P6 direct-inference gap and ownership (2026-10-22):** Source audit found `provider.getLanguage` still flows into ordinary SDK `resolveSDK`/`timeoutFetch`; no direct SessionStore request journal or selected-route ProviderTransport caller is wired. Normative §§14.23.1/37.23.1 require Core-owned PINNED→DISPATCHING→SETTLED/UNKNOWN state over the exact frozen ContextSelection/provider input, then the existing selected-route ProviderTransport and protected SecretBroker callback; no per-request HostKernel call or `providers.infer`. P6 owns direct Core journal/API and provider/Auth/transport integration. P7 owns exact frozen payload/ContextSelection producer. P2 retains managed HostKernel/control/Attempt lifecycle and is not editing direct SessionStore/runner files. P1 retains Guard/ExecutionHost. All routes remain gated; no validation/provider call ran.

**Read-only Git integration gap (2026-10-22):** `packages/core/src/git.ts` wraps the generic AppProcess port with a fail-closed implementation, which blocks read-only status/diff/log/history/tree as well as mutations. The current HostKernel fixed Git status command is limited to P8 child-root final Inspect. P1 is supplying the shared-supervisor preflight/profile requirements; P2 is resolving authenticated Session/Attempt-scoped ordinary Git inspection. Keep raw Core process execution closed; the product route should avoid prompting for each bounded read. No tests run.

**P3 Explorer implementation delta (2026-10-22; source-only):** added authenticated read-only
`/experimental/repo-explorer/discover` and `/read` endpoints backed by the existing Core
SessionSupervisor/HostKernel RepoIntel routes, their SDK projection, and the missing TUI component
for `/editor` and `/editor --side`. The overlay and pane browse bounded tree pages and open regular
files through exact `discovery_observation` revisions; no filesystem fallback or external editor
launch is included. Both components expose an optional exact `(pathRef, sourceRevision)` callback
and a separate Open action after a valid preview; P4 must bind it to the guarded launch adapter.
The TUI rejects mismatched discovery identity/bounds/order/depth, disables
symlinks and unsupported entries, removes terminal/bidi controls and masks credential-shaped
filename labels without changing canonical read refs, and caps preview at 131,072 bytes. P4 still owns external-editor
profile/launch. §30.9 records the source contract. No tests/builds/typechecks/audits ran; route,
SDK-generator consistency, live HostKernel acceptance and final integrated TUI journey remain
unverified. P3 remains PARTIAL / NOT VERIFIED.

**2026-10-22 — P4 external-editor source handoff (PARTIAL; no checks):** P4 added immutable profile request builders and strict ExternalEditor result projection aligned to P1's private EffectHost outcome pins; global-only profile CAS reads now use the same canonical file as writes. P4 owns the Explorer-to-editor interaction contract: after authenticated preview, the optional Open callback now receives exact `(pathRef, sourceRevision, contentDigest)` from that same read. This is the agreed P3→P4 ownership handoff; only the callback argument was changed in the P3 component. The visible launch action remains unwired until P2 exposes the authenticated `editor.prepare/begin/settle/reconcile` HostKernel API and terminal attachment contract. P4 still owes TUI terminal attach/suspend/resume and post-exit conflict projection; LSP/DAP/REPL remain gated pending P1 confinement and executable acceptance. Do not add raw Core spawn, `$EDITOR` shell parsing, or a parallel RPC. No tests/builds/typechecks/audits ran; preserve mixed Git state. P4 returns PARTIAL and remains accountable to resume for dependency integration and acceptance.


## 2026-10-22 — live implementation checkpoint (source only)

Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, and P7 streams/context/artifacts/analytics/automation/rewind. P1 added managed CodeMode authority recovery against live Attempt scope and has now added two P2 integration APIs: `list_direct_session_terminal_artifact_receipts(...)`, which derives terminal artifact refs from exact ordered DirectSession effects, and `active_code_mode_outer_effect(...)`, which resolves the unique active outer CodeMode effect/process/consumed lease by private call ID. P2 must derive authenticated owner epoch and committed batch order before the artifact query; caller refs/paths remain forbidden. P2 is implementing typed CodeMode lifecycle and root artifact projections. P7 owns frozen ContextSelection/provider-input production and nested ToolBatch adapter; P6 owns the durable direct provider request journal and ProviderTransport/Auth and is next for a freed slot.

Child DirectAttempt artifacts have list/inspect/range source paths. Root DirectSession artifacts remain gated pending the P2 authenticated Session/batch/effect/receipt-to-ArtifactStore projection. CodeMode lifecycle/nested calls, provider dispatch, automation invocation and checkpoint restore remain unavailable where dependencies are incomplete. No tests/builds/typechecks/audits/provider probes/benchmarks/release gates have run under the user's instruction to implement first. Mixed Git state remains unstaged. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


**Live roster correction (2026-10-22):** P1 returned PARTIAL source handoff and retains P1 integration/acceptance accountability. Active phase owners are P2, P7 and newly resumed P6; P6 owns direct provider request journal/ProviderTransport/Auth, P7 the frozen ContextSelection producer and ToolBatch nested adapter, P2 managed HostKernel and CodeMode lifecycle. P3/P4/P5/P8/P9 remain unfinished and are queued for subsequent slots. Implementation-first hold remains; no checks run.


**P2/P7 interface delta (2026-10-22):** P2 has added the strict private `CodeModeCall` envelope in Rust protocol/Core supervisor and `SessionSupervisor.codeModeHostRequest(...)`, binding session/location/callID/lane/optional managed scope outside the frozen public request body. HostKernel now routes authenticated inspect and rehydrates exact current-epoch direct/managed authority through P1's recovery APIs; start/resume/cancel/enablement remain unavailable pending durable enablement, frame/tool-set validation and supervisor dispatch. P2 is wiring launch next. P7 will send P6 only the frozen directContext (request ID, source revision, profile ref/digest, ContextSelection); P6 captures and hashes the exact prepared selected-route payload once at RequestExecutor, with no credential/header bytes in the handoff or digest. No tests run.

## 2026-10-22 — source integration handoff: direct route and artifact provenance

P2 is implementing a HostKernel-owned immutable root DirectSession ToolBatch admission index in the existing durable location authority store. It binds authenticated Session/Location/owner epoch/request/batch plus canonical ordered call/effect identities and digest; incomplete or restart-ambiguous admission is UNKNOWN and cannot expose artifacts. It joins those admitted effect identities to P1's terminal EffectHost receipts and existing ArtifactStore metadata; it is not a receipt authority or a second artifact store. P6 is adding the trusted route projection at Core's existing selected-model/catalog resolver boundary; the protected transport must match it exactly. P7 has removed the invalid `model.route.id` fallback and is consuming P6's projection. Direct `permissionScopeDigest` is the authenticated HostKernel permission-mode digest; Core privacy/budget `policyDigest` remains separate, and neither grants tool-effect authority. These contracts are recorded in arch_V1 §§15.2, 17.26 and 37.12. Source only; no tests/builds/typechecks/provider calls/audits. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — active owners restarted; local source comparison

The prior P2/P6/P7 agent threads reached the platform usage limit and stopped. Current whole-phase owners are P1, P2 and P6; P7 is queued for the next slot. Parent reviewed actual in-repository OpenCode `subagent-job.ts`, `subagent-completion.ts`, `execution/restart.ts` and Codex `codex_delegate.rs`, `thread_manager.rs`, inter-agent message/notification source; adaptation and boundaries are recorded in §42.19. Direct route projection must come from Core's selected catalog resolver and be matched by the protected transport. Root direct artifact provenance requires P2's authenticated immutable ToolBatch admission index and P1's terminal EffectHost receipt. No tests/builds/typechecks/audits/provider probes ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 resume note

Active source owners: P1 (`/root/p1_guard_executionhost_full`), P2 (`/root/p2_managed_lifecycle_full`), P7 (`/root/p7_streams_context_artifacts_automation_rewind`); parent coordinates integration. P2 owns the managed reducer/DAG source path after P8's partial source handoff and is authorized to fix the stale capacity-one gate in `kernel/src/managed_control.rs`, preserving distinct workspace lease checks. P1 owns root-session grant preflight and fixed-argv workspace command-profile dispatch; P7 owns the renderer redaction fixes and remainder of P7. Cgroup deletion policy: bounded janitor removes only proven isolated empty cgroups after persisted quiescence and exact identity/path checks under the shared exclusive namespace lock; the 256 cap is a bounded quarantine for uncertain groups, not a lifetime launch cap. Keep all runtime gates closed pending integrated acceptance. User requested implementation before tests; do not run tests/builds/typechecks/audits/provider calls/benchmarks/release checks yet. Preserve mixed Git state; nothing staged/committed/pushed. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**P2/P7 current source delta (2026-10-22):** P2 removed the capacity-one `max_workers.min(1)` restriction in the managed reducer. Admission now honors `maxWorkers`, validates retained Attempt ownership, rejects duplicate/reused mutable Locations, and requires verified dependencies; this does not imply accepted runtime fan-out. P7 found CodeMode nested output was digested and sent raw; it is aligning both to the exact bounded redacted projection. Source only; no tests/builds/checks. Continue whole-phase work and keep runtime gates closed.

P2 has confirmed the only CodeMode HostKernel operation currently implemented is inspect; start/resume/cancel/enablement and DirectSession artifact inspect/range still need P2 source integration. The canonical P8 success settlement API already exists in HostKernel (`resolve_managed_final_inspect_receipt_for_terminal` → `WorkerSettlementProofV1::from_host_kernel` → `settle_managed_worker` → worktree disposition); reuse it and the existing owner-epoch disposition-recovery proof. No tests/checks.

P1 source review follow-up: consider cleanup of a newly-created, never-dispatched cgroup when CodeMode controller setup fails before persistence; reclamation must use the exact pinned inode under the namespace lock. Otherwise document the bounded quarantine behavior. Do not relax post-dispatch persisted-quiescence requirements.

P2 also changed managed settlement recovery to return one deterministic eligible terminal Task per call, retaining exact verifier ChallengeSet pins and allowing callers to iterate to `NO_SETTLEMENT_PENDING`; this supports bounded DAGs with multiple successful Tasks while P8 disposition receipts settle individually. No checks ran.

**P2 CodeMode mixed-wave blocker:** Implement the §37.24 ordered call-kind projection explicitly (`effect` or `host_callback`). Never infer it from capability IDs, and never synthesize a lease for a callback. P1 must expose the typed EffectHost identity/settlement/receipt resolver APIs; P2 owns the missing HostKernel `codemode_settle_tool_results` and `codemode_wave_receipts` handlers. Core retains raw output; only bounded redacted projection, digest and byte count go to helper. P2 continues its independent DAG/artifact work; CodeMode remains unavailable. No checks.

P2 DAG recovery now skips Attempts with already durable P8 settlement plus disposition, advances one deterministic remaining candidate, and terminates with `NO_SETTLEMENT_PENDING`; unresolved or old-epoch Attempts remain uncertain. P7 added typed root DirectSession artifact inspect/range and wave-correlated CodeMode cancellation on the Core side. P2 still needs the corresponding HostKernel cancellation handler; routes remain closed. No checks ran.

P2/P7 CodeMode identity seam: include the exact normalized `toolName` from the trusted `SessionTools.resolve` executor in the internal prepared call projection, then P2 compares it to the helper frame and frozen authorized catalog. Never accept a model-supplied name. CodeMode stays gated until this and mixed-call kind settlement are complete.

P7 resolved the missing CodeMode tool identity field: its CodeMode-only DTO now includes the exact trusted `toolName` from the selected executor, with no ordinary ToolBatch API change. P2 must strict-compare frame/catalog/executor names in Rust. No checks.

P1 must resolve a Full Access availability edge: retaining all successful Full Access cgroups eventually turns the 256 quarantine cap into a lifetime cap on that mode. Evaluate using the existing supervised process-tree lifecycle without persistent cgroups, or prove safe removal after exact process-tree quiescence. Full Access must remain unsandboxed and make no cgroup guarantee claim; UNKNOWN/unproven cases stay quarantined. Decision/source work is pending.

**Full Access cgroup resolution:** A Full Access child can access the delegated hierarchy and migrate descendants; `populated=0` cannot prove the process tree is gone. Do not delete visible Full Access cgroups. P1 is changing this mode to use the existing supervised process boundary without allocating retained cgroups, with the durable effect journal still authoritative; on restart, if exact process quiescence is not proven, mark UNKNOWN and never replay. Do not claim cgroup containment or escaped-child crash recovery. Preserve bounded quarantine for genuinely unresolved cgroup identities from modes that allocate cgroups.

**2026-10-22 active source correction:** P1 accepted an authenticated Full Access launch path without persistent cgroups, preserving live process-group supervision and the durable effect journal; restart without exact process-tree proof remains UNKNOWN/no-replay. Confined workspace profiles continue to require cgroup-v2. Codex/OpenCode process-group patterns do not establish crash-proof containment and include documented orphan/child-survival failure modes. P1 is updating the owning architecture/provenance docs.

P1's typed EffectHost CodeMode prepare/settle APIs are source-present. P2 is implementing HostKernel prepare/settle/receipt/cancel and strict normalized call identity checks. The suspected `read_code_mode_wave_outcome` tuple decode defect was not reproduced by parent source inspection; P2 is rechecking. An active admission API mismatch remains: CodeMode prepare uses a private body shape and mixes callbacks into effect-only ToolBatch admission. P1/P2 are aligning one canonical guarded effect admission plus no-lease callback rows, with no parallel executor. No tests/builds/typechecks or gates run.

## P4 capability chips + editor rows — 2026-10-24 (dated addendum)

P4 delivered the Settings capability-chip consumer that P6 reported as missing: a pure
`projectCapabilityChipsViewV1` in `packages/tui/src/routes/session/dialog-settings.tsx` consuming
P6's exact `projectCapabilityChips` / `exposeCapabilityIDsV1` signature. Chips are read-only
presentation (`Requested · Effective · Source · Policy lock · Precedence`); `experimental` renders
OFF unless explicitly requested; `code_present`/design-only rows always render `unavailable` with
wiring truth ahead of tier/platform reasons; an **absent** runtime source renders `unknown`, never
`0` (§16.17); output is bounded (12 unavailable rows + overflow) with an explicit no-authority note.
RED first (`projectCapabilityChipsViewV1` not found, 0/1), then **11/0, 106 expectations**.

§32.44 rows needing no HostKernel route: **EDITOR-003** shell-string `$EDITOR` with flags/command
substitution against a canary resolves `undefined`, canary never created (`editor.test.ts` **11/0,
25 exp**); **EDITOR-013** mounted journey `/settings` → Editors → saved profile → exactly one CAS
PATCH → `Selected: nvim` → Escape → Explorer open/close, exactly one write and no process.
Totals: settings+editor **22/0, 131 expectations**, `editor-route.test.tsx` **2/0, 16**.

Honest limits: the Tools chip reports `effective unknown / catalog unknown` because no trusted
client-side `CapabilityDescriptorV1` projection exists — **parent follow-up: route a trusted runtime
capability projection (§33 registry + feature exposure) to an owner**; changed files are
typecheck-NOT-VERIFIED until A1 releases the slot. Mount-test timeout reproduced at baseline HEAD
and diagnosed as load (budget 30 s → 180 s, assertions and 5 s frame deadlines unchanged).

All P4 gates remain false; LS/DAP/REPL/editor integrated journeys still need P1/P2/P3/P8.

## P9 typecheck rows + DEC-V1-11 license inventory — 2026-10-25

**Typecheck: 3/3 routed rows cleared, no product source touched.** P9 reproduced A1's exact Run C
messages with throwaway single-file TS projects (deleted after capture, no package `tsconfig`
edited, no A1 slot used):

- `test/identity/runtime-service-identity.test.ts(79,34) TS2769` — **not** a vendor/first-party ID
  mismatch: the table is `Record<string, ReadonlyArray<string>>` while `actual` inferred `string[]`,
  and Bun's `toEqual` overloads reject a readonly expectation. Fixed with `actual:
  ReadonlyArray<string>`; the assertion, every expected ID and all four **provider/Auth/LLM
  preservation assertions are unedited**. Focused typecheck **0** (was 1), identity test **2/0, 57
  expectations**.
- `test/cli/run/runtime.boot.test.ts(203,7)` + `(266,7) TS2322` — the fixture had drifted from the
  real contract: `ProviderListResponses[200]` requires `catalogSnapshot`, which the handler emits.
  Re-typed both fixtures against the generated `ProviderListResponse` and added the field.
  Production `resolveModelInfo` is correct and unchanged, so **nothing was routed to P7**. Focused
  typecheck **0** (was 2), boot test **6/0, 27 expectations**, prettier clean.
- Added one exact `.gitignore` exception for `runtime.boot.test.ts` (it was untracked *and* hidden,
  so the overlay audit failed after the edit); `hidden_changed` back to 0.

**Release qualification, candidate NO-GO:** readiness **82/82** re-run; audit **BLOCKED, 15**; gate
**exit 1, BLOCKED, 20** (`install_matrix NOT_RUN`, `signing_update UNAVAILABLE`, no publication,
no signature).

**DEC-V1-11 license inventory — this needs your decision, with a real contradiction found:**
- **4 packages with no license metadata at all:** `@openauthjs/openauth@0.0.0-20250322224806` (a
  direct `packages/opencode` dependency) and `poe-oauth@0.0.8` have neither metadata nor file;
  `seq-queue@0.0.5` and `xmlhttprequest-ssl@2.1.2` have a file but no `license` field.
- **58 packages with no direct LICENSE/NOTICE file**, of which **12 are first-party workspace
  packages** (`@opencode-ai/{codemode,core,effect-drizzle-sqlite,effect-sqlite-node,llm,plugin,
  protocol,schema,script,sdk,server,tui}`) declaring `license: MIT` while **root `package.json` says
  `UNLICENSED`**, root `LICENSE` is byte-identical to upstream (`625f0f…cb6b`), there is **no root
  NOTICE**, and Nix declares `MIT` — **three contradictory statements of fact about the same tree**.
  3 of the 12 also have **no version field**.
- **46 external rows / 32 names**, including Apache-2.0 ×21, MIT ×17, `MIT OR Apache-2.0`, ISC,
  lowercase `apache-2.0`, Unlicense, **CC-BY-3.0 ×1 attribution-bearing (`spdx-exceptions`)**, CC0-1.0,
  and 2 null.
- P9 recorded the **seven inputs a distribution decision needs** (grant; root LICENSE/NOTICE
  authoring; reconciling root/manifest/Nix; per-package rule including missing versions; NOTICE/
  THIRD-PARTY policy for the 46; isolated-store-layout rule; exact-artifact re-audit).
  **No license or notice text was fabricated and no decision was claimed.**

**Parent cleanup of 4 flagged files from other owners:** extended `skip_hidden_file` in
`scripts/architecture/audit_overlay_visibility.py` with a test-first regression so live phase probe
names (`tsconfig.p7typefix.json`, `tsconfig.p7-rows6.json`, `tsconfig.p6focus.json`,
`tsconfig.p6-focus.json`) are classified as the scratch the policy already declares, while
`tsconfig.json`, `tsconfig.build.json` and `tsconfig.a1focus.json` stay visible — **6 tests OK**.
Unignored P7's real test `packages/opencode/test/agent/agent-node-deps.test.ts`. Overlay re-run:
**hidden_changed 0 / hidden_new_source 0 / stale_unignore 0**.

## P3 runbook execution — 43 of 62 acceptance rows, 0 failures — 2026-10-25

P3 executed runbook Phases 3–4 against the current tree (`reports/phases/P3.md` §22) instead of
leaving them unrun by design. **62 acceptance items (58 catalog IDs + 4 cross-cuts); 43 executed;
32 PASS, 11 PASS\*, 18 NOT_RUN, 1 BLOCKED_P2 (RD-017), 1 BLOCKED_P4 (RD-012), 0 FAIL.** Grand
total **362 executions → 360 pass, 1 todo, 1 load-induced timeout, 0 assertion failures** across 8
commands; `session-runner` **102/102**, `repo-tools` **14/14** (after the new 32 KiB cap row),
`artifact-search` **19/19**, schema **35/35**, OpenCode P3 set **95/94 pass + 1 todo**.

**11 new tests written test-first:** CX-003 protected Goal/criteria line survives 20 turns of
trim/prune; CX-014 ×2 anchor digest + static ledger segments stable over 3 consecutive turns;
CX-024 ×2 installed skills project metadata only and never `SKILL.md` bodies, body reachable only
through explicit lookup, sorted/stable output; CTX-001 ledger digest binds the normalized payload and
every request pin; CTX-002 exact/estimated/unknown byte and token classes kept distinct; CTX-003 ×2
excluded entries keep reason/protection/cache state and unpinned inclusion is rejected; CTX-004
`session.context_ledger` is closed, request-fenced and carries **no raw prompt**; plus the `repo_tree`
32 KiB cap and RD-020 credential-shaped path redaction.

Notable rows now proven: **CX-017** `auto never claims cache_anchor when the route reports no prefix
cache` and explicit `cache_anchor` fails closed on an unvalidated route; **CX-018** anchor epoch reuse
requires every workspace/profile/permission pin to match; **RD-010** out-of-scope subpath denied
before any read, symlinks never followed out of scope, and both swap-after-validation attacks rejected;
**RD-011** generation builds coalesce only within the same repository/workspace/read-policy identity
and a cross-epoch join is refused.

Honest red→green records: the CTX-006 parity batch first failed as a 5 s cold `python3 jsonschema`
timeout under load 16–29 (harness budget, not a contract disagreement — an explicit 30 s budget was
declared on those two rows, assertions untouched) → 35/35; one instruction test timed out at 30 s and
passed isolated **7/7**; the new repo_tree row was red on its first label assertion before the fixture
path was corrected → 14/14.

NOT_RUN routed by owner: **P7 8** (CX-005/008/009/010/011/012, CTX-005, INST-004 — queued to P7),
P6/provider 3 (CX-006/007/021 — need a provider), P4 1 (RD-008), P1 1 (RD-009 edit leg), **parent 5**
(RD-001..005 real-repo journey — B4). All navigation/RepoIntel gates remain closed.

## P1 principal gate + integrated HTTP security proof — 2026-10-25

**Root cause found first-hand, not assumed.** `HttpRouter.toWebHandler` types `handler` as
`(request, context?)` only when the route's unsatisfied `Requires` set is `never`;
`SessionV2.Interface.revert.stage/clear` declared `R = TrustedPrincipalContext` (`session.ts:188-200`)
while the server middleware legitimately projects **no** principal at `authorization.ts:62/:69/:79`.

**RED with no principal supplied (never fabricated):** `stage` **succeeded and mutated** — returned
`{"messageID":…,"diff":"","restoreFiles":[]}` — and `clear` **succeeded**: `1 pass / 2 fail`.
**Fix:** `Effect.serviceOption` first in `packages/core/src/session.ts` only → typed
`SessionSupervisorError{stage:"authorization"}` with the exact per-method reason, interface `R`
removed, denial strictly before any mutation. No middleware branch, protocol, or principal provider
was touched.

| Check | Result |
|---|---|
| `session-revert-principal` | **3/0, 11 expectations** |
| revert + process-guard + ripgrep + tool-bash | **13/0, 53 expectations** |
| read-batch-context + `session-direct-read-batch` | **27/0, 447 expectations** |
| **new** `server: session-revert-authorization` (×2) | **3/0, 15 expectations** |
| `tsgo --noEmit` for `packages/core`, `sdk-next`, `server` | **exit 0 / 0 / 0** (former `TS2554` gone) |
| overlay / markdown / convergence | **exit 0, hidden 0/0/0** · **0 active blockers** · **1300/0** |

**Integrated HTTP proof on real `createEmbeddedRoutes()` / `createRoutes("secret")` stacks:**
unauthenticated non-loopback `stage` → **403** typed `ForbiddenError`, **zero revert events**,
`revert` NULL; `clear` → **403** with the staged row preserved; anonymous or wrong Basic → **401**;
genuine `server_auth` → `stage` **200** / `clear` **204** with exactly `revert.staged.1` +
`revert.cleared.1`. This is real Guard-equivalent evidence for the principal boundary, not a unit
assertion.

**New gap routed back to P1 and now assigned:** `session.revert.commit` had **no principal gate at
all** (`packages/core/src/session.ts:543`, called from `packages/server/src/handlers/session.ts:304`).
Ownership resolved to P1 — same file, same seam as stage/clear, no protocol change needed — with the
same RED-first requirement (commit must be shown mutating without a principal before the fix).

Concurrency note: a second P1 continuation landed the P1-10 client seam at the same time and
appended a duplicate `§34`; P1 renumbered it to `§35` preserving content and reconciled the ledger
row (its "sdk-next NOT VERIFIED" claim is superseded by the exit-0 runs). No file lost, no parallel
write raced afterwards.

P1 remains **PHASE_PARTIAL**: `embedded.test.ts` **1/3/2** still needs the P6 authority decision I
routed; B4 OS containment is **NOT RUN — this host has no user-owned delegated cgroup root** (stated,
not faked; `cgroup_v2` greens are unit negatives only); integrated grant/profile/terminal receipt
journeys and live Core→HostKernel bootstrap remain open; Rust re-runs wait behind P2's explicit Cargo
release. Both readiness gates remain **false**.

## P7 continuation 24/24b — product failures root-caused, 6 typecheck rows to zero — 2026-10-25

**The 14 `tool.task authenticated dispatch` failures had one shared root cause, not `task.ts:276`:**
`Service not found: @opencode/v2/Plugin` at `Agent.state` → `agent.ts:215` → `task.ts:398/1513`.
Trigger: a repo-local `TMPDIR` puts the test instance inside the worktree, so `ConfigPaths` picks up
`.opencode/opencode.jsonc` → `references` → `agent.ts:222-227`, whose `PluginV2`/`Reference` come only
from `locations.get(ref)` — a layer `task.test.ts:434-443` stubs to `AgentProfileService` alone.

- **Both proposed candidates were rejected against the file's own convention:** adding
  `PluginV2.node → SkillV2.node → Location.node` makes every root compile throw `Unbound layer node`;
  hoisting moves the requirement to a context that also lacks them. **Fix:** `Effect.serviceOption`
  for both services inside the existing `locations.get` provide. `Agent.node` deps untouched; an
  absent service ⇒ no whitelist ⇒ default `ask` (**fail-closed**, not permissive).
- **RED** first in new `packages/opencode/test/agent/agent-node-deps.test.ts`. **GREEN:**
  `agent-node-deps` **2/0, 4 exp** · `instance-state` **3/0, 3 exp** · `task.test` **6 pass / 12 fail /
  75 exp, 0 Plugin hits** · **P6 `config.test` 112/0, 199 expectations** (the post-fix rerun P6 was
  waiting on) · `repo-tools` **14/0, 66 exp**.

**The 12 remaining are P2-owned and were reported at the boundary, not edited:**
1. `no such table: direct_subagent_inbox` ×6 — `DatabaseMigration.apply` seeds from `schema.gen.ts`
   then marks every `migration.gen.ts` id complete, but the inbox tables are absent from the
   generated schema. On the tree now: `migration.gen.ts` **modified**,
   `20261020090000_direct_subagent_inbox.ts` **modified**, and
   `20261023120000_managed_subagent_inbox_consumption_proof.ts` **untracked but Git-visible**.
2. `cancel_direct_attempt: stale direct Attempt revision` ×5 (Attempt stuck `EXECUTING`) — proved
   with a reverted instrument: `managed-control.ts:7166-7193` sends a **bigint**,
   `decodeDirectAttempt` yields a canonical **string**, the kernel compares strictly against a
   **number**, unlike `bind_direct_attempt_effects` which coerces `BigInt(String(...))`.
3. Contract flag: `DirectScopeFacts`/`scopeDigest` never covered `profileRevision`; 3 excess call-site
   facts were removed and proven **digest-neutral** — P2 must either add the pin with digest coverage
   or record the decision that it is intentionally absent.

**Six assigned typecheck rows: 6 → 0** via focused `tsconfig.p7-rows6.json` (not A1's package slot).
Two *non-owned* diagnostics remain in that run — `image.ts(5,24) TS2307`
(`@silvia-odwyer/photon-node/photon_rs_bg.wasm`, package present at
`packages/opencode/node_modules/…`, declaration currently only in `src/audio.d.ts`) and
`managed-artifact-search.ts(378,124)` (the helper session's row). Left for the owner / Run D rather
than patched blind.

**P3 §22 rows:** **CX-008 PASS** with a new test (`harness-profile-tool-projection.test.ts` **5/0,
29 expectations** — the pure lazy-exposure split had zero coverage). The other 7 are **NOT_RUN with
reason + owner** rather than faked: CX-009/CX-012 have no implementation in tree, CX-010 is also
blocked by cause (A), CX-011 has no TUI `/clear` epoch marker, INST-004 has no delivery-root
instruction-set builder, CX-005 needs a real tokenizer/usage run, CTX-005 needs an in-flight provider
request. None inherited `BLOCKED_P2`/`BLOCKED_P4`.

Safety: no Git/Cargo/provider/network/package-wide typecheck; no P2/P6/`supervisor.ts`/Rust/P8/P9
source edited; all effect gates false; diagnostic residue `rg P7DIAG|P7PROBE|P7TRACE` → **0**; three
new files unignored and Git-visible; 826 GB free.

## A2 closed — P1-10 read fast path wired into the runner (direct Sessions only) — 2026-10-25

**Lane ruling taken from the authorities before enabling anything:** `arch_V1/14` §14.3.1 — *"Managed
lane: read fast path is optional and **off by default** for Attempt-bound waves"*; `DEC-V1-36` —
*"Read-class tools in **direct Sessions** may use the §14.3.1 read fast path … Managed mutating
Attempt chains remain strict."* → **only direct Sessions qualify**, encoded in code and tests; the
managed/child/CodeMode lanes never take it.

**RED first** (`packages/core/test/session-runner-direct-read-routing.test.ts`): `SyntaxError: Export
named 'directReadFastPathV1' not found` → **0 pass / 1 fail**. Six cases: read-class routed with an
exact envelope `requestID`; a bound `requestID` sent as-is while rows bound to another request are
rejected whole-wave; mixed read+effect falls back; >8 denied **locally with zero host contact**;
managed/attempt/child/CodeMode lanes never taken; the runner seam really invokes it.

**Implementation (3 P7-owned files):** `runner/llm.ts` exports `directReadFastPathV1` (mints
`req_<uuid>` when absent, delegates to `DirectReadBatch.runWave`, converts any escaped failure into a
whole-wave `denied` / `replay:"forbidden"`) and wires it at the recorded seam as an `else` on
`if (guarded)` — **all `LLMEvent.toolResult` publication is deferred until `runWave` reports
`published`**, i.e. the fence runs before any result is visible; per-call errors publish only on
`denied`, and `unavailable` continues the ordinary loop byte-for-byte as today. Lane is
`direct_session`, with `parentSessionID` from `session.parentID` so managed Attempts (children of the
managed root) are refused. `direct-read-batch.ts` now sends P1's envelope binding
(`requestID` in `requestHostKernel` options). A member with no bounded text ⇒ `rejected` ⇒ the
publication gate denies the whole wave (no partial `calls`).

**GREEN (verbatim, `packages/core`, repo-local TMPDIR):**

| Command | Result |
|---|---|
| `bun test --timeout 60000 test/session-runner-direct-read-routing.test.ts` | **6/0, 33 expectations** |
| `bun test test/session-direct-read-batch.test.ts test/session-supervisor-read-batch-client.test.ts` | **34/0, 484 expectations** |
| `bun test test/session-runner.test.ts test/session-runner-compile-boundary.test.ts` | **105/0, 380 expectations** |
| `tsgo --noEmit -p tsconfig.p7-wiring.json` (3 files) | **exit 0** (4 → 0) |

First typecheck round's 4 diagnostics were all P7's own and all fixed without weakening types
(`session.metadata` absent on core `Session.Info`, `ToolOutput` vs `string`, `RunTurn` error
`unknown`, and `Effect.catchAll` does not exist in effect v4 — replaced with this file's own
`Effect.catch`).

**Honest NOT_RUN:** `test/session-runner-recorded.test.ts` fails before assertions with
`ENOENT: kernel/target/debug/session_supervisor` — the Rust observer binary does not exist because P2
holds Cargo. Not caused by this change; the real provider-backed §32.49 read turn stays **NOT_RUN,
owner P7, after P2 releases a build.**

Not fabricated: the 12 `tool.task` failures stay routed to P2; `image.ts` TS2307 waits for A1's Run D
attribution; the 7 P3 rows remain NOT_RUN because `rg` proved four have no implementation in the tree,
CX-010 is blocked by P2's `direct_subagent_inbox` baseline, CX-005 needs a real tokenizer run and
CTX-005 needs an in-flight provider request.

## P1 `revert.commit` principal gate — 2026-10-25

Parent routed the §34.7 gap back to P1: `session.revert.commit` had no principal gate.
Resolved to the **same file, same seam, same mechanism** as `revert.stage`/`revert.clear`
(`packages/core/src/session.ts:545`).

**Caller audit (first-hand, exhaustive):** `grep -rn "revert\.commit" packages --include=*.ts`
(excluding `node_modules`, `/dist/`, generated) → the **only** Core caller is
`packages/server/src/handlers/session.ts:307`. Everything else is an event-type string, a
generated SDK/client wrapper, or the HTTP route row in
`packages/opencode/test/server/httpapi-exercise/index.ts:1028`. No second Core path reaches
the seam. `packages/app/src/utils/server-compat.ts:298` is the *generated client* function —
it goes over HTTP through the same gated handler, not a bypass.

**RED (no principal, never fabricated):** `revert.commit` **succeeded and mutated** — with a
post-boundary message seeded at `seq: 2`, the pre-fix run printed
`expect(outcome.value.events).toEqual([])` → `+ "session.next.revert.committed.1"`, i.e. an
unauthenticated caller could write the committed event, null the staged revert and **delete**
the post-boundary message (`projector.ts:445-483`). **4 pass / 1 fail / 15 expectations.**

**GREEN:** `Effect.serviceOption(TrustedPrincipalContext)` first → typed
`SessionSupervisorError { stage: "authorization", reason: "Authenticated principal required to
commit a Session revert" }`, denial strictly before `result.get` and before any mutation.
`Interface.revert.commit` widened to `Effect.Effect<void, NotFoundError | SessionSupervisorError>`.
**`R` was unchanged, not removed** — `commit` never declared `R = TrustedPrincipalContext`
(unlike stage/clear), so there was no `R` to remove; the required change is an error-union
widening.

**The "no protocol or handler change" premise: protocol ✓ held, handler ✗ did not — compiler
quoted as instructed.** With only the Core change:

```
src/handlers/session.ts(305,9): error TS2345: ... not assignable to 'HandlerWithName<...>'.
  Type 'Effect<void, SessionNotFoundError | SessionSupervisorError, never>' is not assignable to
  type 'Effect<void | HttpServerResponse, InvalidRequestError | ServiceUnavailableError |
  SessionNotFoundError | UnauthorizedError, never>'.
    Type 'SessionSupervisorError' is not assignable to type 'UnauthorizedError'.
      Types of property '_tag' are incompatible.
        Type '"SessionSupervisorError"' is not assignable to type '"UnauthorizedError"'.
SERVER_EXIT=2
```

`SessionSupervisorError` is in the Core channel the handler must consume and is not assignable
to the endpoint's effective error set, so a handler-side mapping is unavoidable. The allowed set
is exactly `InvalidRequestError | ServiceUnavailableError | SessionNotFoundError |
UnauthorizedError` (endpoint-declared + API-level `Authorization`/`SchemaErrorMiddleware`);
**`ForbiddenError` is not in it**. Minimal fix applied at `packages/server/src/handlers/session.ts:304-324`
(`Effect.catchTag` → `Effect.mapError`, denial → `UnauthorizedError` 401 with the verbatim
message). **`packages/protocol/**` untouched** — `session.revert.commit` still declares
`error: SessionNotFoundError`, so the public contract/OpenAPI/generated clients are unchanged.

**Deviation flagged for parent audit:** that is a *handler* edit outside P1's nominal
`session.ts`+tests scope, made because the compiler proves a Core-only gate cannot reach HTTP,
the required HTTP commit row cannot pass without it, and "keep `tsgo` at 0" is unconditional.
If 403-consistency with stage/clear is preferred, the alternative is a one-line protocol edit
(`error: [SessionNotFoundError, ForbiddenError]` at `packages/protocol/src/groups/session.ts:293`)
+ `mapSupervisorError` — that **is** a public-contract change and was deliberately **not** done.
Known inconsistency recorded: stage/clear answer **403**, commit now answers **401**, same
missing-principal condition; both deny.

| Command | Result |
|---|---|
| `cd packages/core && TMPDIR="$PWD" bun test test/session-revert-principal.test.ts` (pre-fix RED) | **4 pass / 1 fail / 15 expectations** |
| same command (post-fix) | **5 pass / 0 fail / 18 expectations** |
| `cd packages/core && TMPDIR="$PWD" bun test test/session-revert-principal.test.ts test/process-guard.test.ts test/ripgrep.test.ts test/tool-bash.test.ts` | **15 pass / 0 fail / 60 expectations** |
| `cd packages/core && TMPDIR="$PWD" bun test test/session-supervisor-read-batch-context.test.ts test/session-direct-read-batch.test.ts` | **27 pass / 0 fail / 447 expectations** |
| `cd packages/server && OPENCODE_DB=:memory: TMPDIR="$PWD" bun test --timeout 400000 test/session-revert-authorization.test.ts` | **5 pass / 0 fail / 27 expectations** (was 3/0/15) |
| `cd packages/core && TMPDIR="$PWD" ../../node_modules/.bin/tsgo --noEmit` | **exit 0** |
| `cd packages/server && TMPDIR="$PWD" ../../node_modules/.bin/tsgo --noEmit` | **exit 0** |
| `cd packages/sdk-next && TMPDIR="$PWD" ../../node_modules/.bin/tsgo --noEmit` | **exit 2**, one diagnostic **not P1-owned**: `p6-embedded-probe.ts(26,48) TS2339` — untracked P6 scratch probe (mtime 2026-10-25 01:33, after §34.8's green run), zero rows in `packages/sdk-next/src`. Reported, not deleted; routing to P6 is the parent's call. |

**HTTP negatives on the real route stacks:** unauthenticated `revert/commit` → **401**
`{"_tag":"UnauthorizedError","message":"…Authenticated principal required to commit a Session revert"}`,
`events == []`, staged `revert` preserved, post-boundary message intact; anonymous/wrong Basic →
**401**/**401**; genuine `server_auth` → stage **200**, commit **204**, events **exactly**
`revert.staged.1` + `revert.committed.1`, `revert` NULL, post-boundary message deleted. Existing
stage 403 / clear 403 / authenticated 200+204 rows unchanged and green.

**P7 `options.requestID` — confirmed present in source:** `packages/core/src/session/direct-read-batch.ts:569-575`
now passes `requestID: input.requestID` in the `requestHostKernel` options; covered by the green
**27/0/447**. P7 still owns declaring it done and the runner-wiring decision.

Files changed: `packages/core/src/session.ts` (gate `:545-561`, Interface `:197-199`),
`packages/server/src/handlers/session.ts` (import + `:304-324`), the two P1 revert test files,
`reports/phases/P1.md` §37. **Untouched:** `packages/protocol/**`, Rust, Cargo,
`kernel/src/effect_host.rs` (that is §36's concurrent session). No Git, no provider/network, no
worktree, no scratch left (one transient `.p1-core-tsgo.txt` created and deleted), nothing staged.
No `host_os`/`server_auth` was ever fabricated for a negative; both terminal readiness flags stay
`false`. P1 remains **PHASE_PARTIAL / NOT VERIFIED / NOT RELEASED**.

## P2 HostRun route complete; 12 product failures fixed; Cargo released — 2026-10-25

**Mission deliverables (A1's largest remaining gap):**
1. **`HostRunDispatchBindingV1` persisted pre-dispatch**, keyed by the **BLAKE3 of the dispatch key**
   (raw key never persisted), with every authority pin derived by HostKernel, exposed on a new
   `managed.v1/host_run.bind` route taking the strict body
   `{goalID, attemptID, dispatchKeyDigest, manifestDigest, evaluatorTaskId, armId, taskGroup}` and
   returning `{binding, receipt}`. Per-wave projection requests now use the durable edge scope digests.
2. **Read-only `managed.v1/host_run.inspect`** joins, in order: binding → P2 receipt → **P8 OwnerLog
   receipt** → Run/Task/Attempt terminal + final workspace revision → ordered P1 projection echo →
   full verifier evidence (`verificationRunID`) → HostKernel verifier pins (`setIdentityDigest`,
   `challengeSetDigest`) → P8 settlement receipt, exposing roughly **10 typed UNKNOWN reasons that can
   never authorize redispatch**.
3. **All of P8's negative-matrix cases covered** in `--lib host_run`.

**Rust results (serialized from `kernel/`, logs in `kernel/tmp-p2/`):**

| Target | Result |
|---|---|
| `cargo test --lib host_run` | **12/0** — binding, reconcile, P8-receipt, route |
| `--test direct_attempt_rpc` | **10/0** |
| `--test managed_control` | **39/0** |
| `--test task_dag` | **17/0** |
| `--lib codemode_protocol` | **6/0** |
| `--lib jc_res_012` (P8's fixture incl. the TS-consumer-pointer assertion) | **4/0** |
| `--test tool_batch_guard_matrix` | **3 pass / 6 failed** — all six inspected: 5× PTY journey + 1× cross-capability, every one `capability_unavailable` **before** `effect_denied`; intentional readiness-false denials, gate untouched |
| `--test host_terminal_events_process` / `host_terminal_process` | **0/1** / **2/1** — same intentional denials |

**The 12 `tool.task authenticated dispatch` failures are fixed:** baseline **6/12** → **12/7** after
cause (B) → **18/1** after cause (A) → **19 pass / 0 fail** final (including a new 42-expectation
variant test). `managed-control.test.ts` **41/0, 225** unchanged; `migration.ts --check` **exit 0**.
P2's `DirectScopeFacts` decision recorded: it **excludes** the profile pin, with the rationale in the
type's doc comment — P7's 3 removed facts stay removed.

**Cargo explicitly released** at base `44f8b5f2a` with file fingerprints recorded in
`reports/phases/P2.md` cont. 30; final check showed no `cargo`/`rustc` process. Caches retained
(`target-p2` 5.2 GB, `kernel/target` 1.8 GB), 825 GB free. All jobs were serialized with
`CARGO_BUILD_JOBS=1`, and a foreign `codemode_wave_reader_fence_tests` job was **waited out** rather
than duplicated.

**Cross-phase handoffs now dispatched:**
- **P1** implements `HostRunEffectProjectionSourceV1::project_committed_batch(...) -> Result<...,
  ManagedError>` over persisted rows (exact echo via `validate_against`, completeness via
  `is_complete_terminal`, any mismatch → `Err(Conflict)`), installed with
  `HostKernel::install_host_run_effect_projection_source`. Until installed, `host_run.inspect`
  correctly returns the typed `host_run_effect_projection_unavailable` UNKNOWN. P2 handed P1 that one
  symbol plus its tests inside P2's `managed_control.rs` and nothing else; P1 holds Cargo.
- **P8** implements append (`host_run.bind`) → post-commit receipt (`host_run.bind_receipt`, which is
  where the OwnerLog cursor/event digest comes from) → resolve (`host_run.inspect`), and builds the
  authentic positive fixture; dependent assertions are **BLOCKED_P1** until P1's projection installs.
  P8 has no Cargo.

**B2 (full Rust acceptance) is queued behind P1's release of Cargo.** Remaining P2 ledger: managed
admission positives (1/3), CodeMode lifecycle, root-artifact integration, DAG/per-Task aggregate
settlement, P7 `InstanceRef` HTTP journeys, resume-success re-arm when
`DIRECT_CHILD_TURN_RPC_ENABLED` opens, a P7-owned `task.ts:640` swallow review, and the queued
`DecimalU64` wire handoff. P2 = **PHASE_PARTIAL / NOT VERIFIED / NOT RELEASED**.

## P1 `session.revert.*` denies 403 family-wide — 2026-10-25

Parent ratified the §37 handler deviation and chose **403**: `stage`/`clear`/`commit` are one API
family and must deny identically (401 stays for bad credentials).

**Derivation check run first, as instructed:**

| Path | Verdict |
|---|---|
| `packages/sdk/js/src/v2/gen/*` | **Byte-generated** (`script/build.ts:14` dumps OpenAPI from `packages/opencode`, whose `httpapi/api.ts:34` imports `makeApi` from `@opencode-ai/protocol/api`; `@hey-api/openapi-ts` with `clean: true`). Declared errors do flow in — `V2SessionRevertStageErrors` already has `403: ForbiddenError`. **Moves:** `V2SessionRevertCommitErrors` gains `403: ForbiddenError`. |
| `packages/app/src/utils/server-compat.ts` | **Hand-written**, uses only `Parameters<Fn>[0]`. **Unaffected**, nothing to regenerate. |
| `packages/client/src/generated/*` (not on the list; found by the check) | **Byte-generated** — `httpapi-codegen/src/index.ts:520` `declaredStatuses = [...new Set(endpoint.errors.map(e => e.status))]`. **Moves:** `client.ts:433` `[404, 400, 401]` → `[404, 403, 400, 401]`. `generated/types.ts` + `generated-effect/client.ts` unaffected. |

**RED** (`revertOps` table over all three ops): `"op": "commit"` expected **403**, received **401** →
**6 pass / 1 fail / 41 expectations**; `stage`/`clear` already 403 and bad-Basic already 401 for all
three.

**GREEN:** `packages/protocol/src/groups/session.ts:293` → `error: [SessionNotFoundError, ForbiddenError]`
(additive; `ForbiddenError` already imported `:12`); `packages/server/src/handlers/session.ts:304-331`
→ `new ForbiddenError({ message: error.message })`, unused `UnauthorizedError` import dropped.

**`mapSupervisorError` verbatim does not typecheck here — compiler quoted:** with the authorized
array in place,
`Type 'ConflictError' is not assignable to type 'ForbiddenError | InvalidRequestError | ServiceUnavailableError | SessionNotFoundError | UnauthorizedError'` (its declared return is
`ForbiddenError | ConflictError | ServiceUnavailableError`; the 409 `stage: "ownership"` arm is
neither producible by `revert.commit` nor declared on this endpoint). Resolved **in favour of your
exact contract array**, since declaring 409/503 would exceed the additive bound you authorized and
multiply the churn you asked me to minimize. The inlined body is `mapSupervisorError`'s own `:26` arm
**byte-for-byte** (`return new ForbiddenError({ message: error.message })`), so runtime status/body
match stage/clear exactly; only the helper *call* is local, documented at the site. Literal-helper
alternative = widen to `error: [SessionNotFoundError, ConflictError, ForbiddenError,
ServiceUnavailableError]` (mirrors `clear`) — larger contract+churn delta, **not** done.

| Command | Result |
|---|---|
| `cd packages/server && OPENCODE_DB=:memory: TMPDIR="$PWD" bun test --timeout 400000 test/session-revert-authorization.test.ts` (RED) | **6 pass / 1 fail / 41 expectations** |
| same (GREEN) | **7 pass / 0 fail / 45 expectations** (was 5/0/27) |
| `cd packages/core && TMPDIR="$PWD" bun test test/session-revert-principal.test.ts` | **5 pass / 0 fail / 18 expectations** |
| `cd packages/core && TMPDIR="$PWD" bun test test/session-revert-principal.test.ts test/process-guard.test.ts test/ripgrep.test.ts test/tool-bash.test.ts` | **15 pass / 0 fail / 60 expectations** |
| `cd packages/core && TMPDIR="$PWD" bun test test/session-supervisor-read-batch-context.test.ts test/session-direct-read-batch.test.ts` | **27 pass / 0 fail / 447 expectations** |
| `tsgo --noEmit` core / server / sdk-next | **exit 0 / 0 / 0** (P6's `p6-embedded-probe.ts` was removed by its owner, clearing §37's residual) |
| `cd packages/client && TMPDIR="$PWD" ../../node_modules/.bin/tsgo --noEmit` | **exit 0** (direct consumer of the changed protocol) |
| `cd packages/codemode && bun test test/openapi.test.ts` | **26 pass / 0 fail / 138 expectations** |
| `cd packages/httpapi-codegen && bun test test/generate.test.ts` | **60 pass / 0 fail / 113 expectations** |

**⚠ PENDING, deliberately NOT run — regeneration.** No `bun run generate` / `bun dev generate`
anywhere. Two files must move: (1) `packages/client/src/generated/client.ts:433`
`declaredStatuses: [404, 400, 401]` → `[404, 403, 400, 401]` — `cd packages/client && bun run generate`;
(2) `packages/sdk/js/src/v2/gen/types.gen.ts:13913` `V2SessionRevertCommitErrors` gains
`403: ForbiddenError` — `cd packages/sdk/js && bun run build`, which uses `output.clean: true`
(wholesale rewrite of `src/v2/gen`; the churn risk flagged). **Consequence:** `.github/workflows/test.yml:72-75`
runs `bun run check:generated`, so **CI fails on this source change until (1) is regenerated and
committed**; runtime is already correct (server returns 403), only the checked-in client lags — until
then a `packages/client` consumer sees `ClientError("UnexpectedStatus")` instead of the parsed
`ForbiddenError` for this endpoint. Both are yours to authorize.

**Overlay:** `audit_overlay_visibility.py` → exit 1, `hidden_changed=0 hidden_new_source=4
stale_unignore=0`; the four are `packages/opencode/tmp/probe-{provider,v2,v3,v4}.ts` (other owner).
This round added **no new file**, so **no `.gitignore` edit** was made and the four were left to their
owners. The previous round's four findings are already cleared.

Files changed: `packages/protocol/src/groups/session.ts:293`, `packages/server/src/handlers/session.ts`
(`:304-331` + import), `packages/server/test/session-revert-authorization.test.ts` (`revertOps` table
+ 2 table cases, commit row 401→403), `reports/phases/P1.md` §38. **No** `.gitignore`, **no**
generated file, **no** Rust/Cargo, **no** `kernel/src/effect_host.rs`, **no** Git write, **no**
provider/network, **no** scratch left. Both readiness flags stay `false`; no principal fabricated.
P1 remains **PHASE_PARTIAL / NOT VERIFIED / NOT RELEASED**.

## P1 supervisor startup diagnostics + regeneration outcome — 2026-10-25

Full evidence in `reports/phases/P1.md` **§39** (§38.5 updated in place with the two verbatim stats).

**Item 1 `cd packages/client && bun run generate` → EXIT 1, wrote nothing.** `GenerationError:
Unportable schema: skills.skill.list.success` at `httpapi-codegen/src/index.ts:618`. Measurement
`git diff --stat -- src/generated src/generated-effect` = **empty**. Not caused by the revert change:
`makeSessionGroup` is added at `protocol/src/api.ts:41`, `SkillGroup` at `:50`, so
`session.revert.commit` normalised and passed first; and a read-only probe replicated the
portability predicates to the exact leaf — `skills.skill.list.success.data.rest[0].identity [Objects]
checks -> Filter check annotations=undefined`, i.e. `Skill.Info.identity`'s `Schema.makeFilter` at
**`packages/schema/src/skill.ts:49-65`** has no filter annotations, and `checksPortable`
(`index.ts:858-869`) requires `annotations.meta` + `arbitrary.constraint`. That `makeFilter` **is in
HEAD** (`git show HEAD:…skill.ts` → line 50). **⇒ CI `check:generated` cannot pass from regeneration
alone; needs that filter annotated (owner of `packages/schema/src/skill.ts`). Not edited by P1.**

**Item 2 `cd packages/sdk/js && bun run build` → EXIT 1 after hey-api rewrote `src/v2/gen`. STOPPED
at the stop-condition.** VERBATIM:

```
 packages/sdk/js/src/v2/gen/sdk.gen.ts   | 13959 ++++++--------
 packages/sdk/js/src/v2/gen/types.gen.ts | 28997 ++++++++++++++++--------------
 2 files changed, 21306 insertions(+), 21650 deletions(-)
```

- Intended change **did land**: `V2SessionRevertCommitErrors` = `400/401/403: ForbiddenError/404/503`.
- Build died at `patchGoalReviewNullability` (`script/build.ts:174`, `expected 1 maxMemoryBytes fields,
  found 2`), and both `Bun.write` calls for the post-patches are **after** that point ⇒ on-disk files
  are **raw unpatched hey-api output** (missing the history-numeric, Goal-review-nullable and SseFn
  patches).
- **Other owner's hunk destroyed**: `grep -ic subagentwait` = 0 in both files; the pre-existing
  uncommitted `SessionSubagentWaitErrors/Responses` import addition to `sdk.gen.ts` was overwritten by
  `output.clean: true` and cannot be restored from Git (it was uncommitted). Its exact content (2
  inserted import lines) was captured earlier this session.
- Overlay regressed from `hidden_changed=0` → **`hidden_changed=13 hidden_new_source=2`**, all 13 in
  `packages/sdk/js/src/v2/gen/{client,core}/` plus `packages/sdk/js/openapi.json` from this run (the
  other new source is `scripts/eval/blake3.py`, other owner). **No `.gitignore` entry added** —
  unignoring paths of a half-finished regeneration you may revert would be premature.

**Supervisor startup diagnostics (P1-owned, test-first, fake child):** `supervisor.ts:3663` used to
report only `supervisor exited before binding its socket (…)` while both spawn sites passed
`stderr: "ignore"`. Now both spawn sites use `stderr: "pipe"` (`:3918`, `:4684`), a bounded 8 KiB
drain starts at spawn (a piped-but-unread stderr would block the child), and both child-death branches
append `; exit code N; stderr: <tail>` resolved within a 500 ms bound. RED `16 pass / 2 fail / 51`
→ GREEN **`18 pass / 0 fail / 53`** (`packages/core/test/session-supervisor-launch.test.ts`). No lease,
permission or socket-ownership check and no readiness flag was touched.

**Hand-offs (reported, not edited — outside `supervisor.ts`):**
- **P9 / CLI `run`:** `packages/opencode/src/cli/cmd/run/runtime.ts:757-759` — `if (!next?.id) throw new
  Error("Session not found")` discards the cause, so a bring-up failure is misreported as a missing
  session (exit 1). Needed: carry the cause (`{ cause }`) or surface the upstream error. Supporting:
  `packages/opencode/src/cli/cmd/run.ts:461-466` swallows `sdk.session.get` via `.catch(() => undefined)`
  before `UI.error("Session not found"); process.exit(1)`. Both tracked and unmodified.
- **App-path vs standalone:** `ensurePrivateDirectory` (`supervisor.ts:2430-2460`) already enforces
  owner-only `0700`, canonical path, uid match and `(parent.mode & 0o022) === 0`, so the directory the
  app creates is compliant with the kernel's `InsecureDirectory` rule; which child-death branch fires
  and what the child printed was unobservable until §39.4. **No cause asserted that was not observed** —
  the next E2E attempt should be read against the enriched message first.

| Command | Result |
|---|---|
| `cd packages/core && TMPDIR="$PWD" bun test test/session-supervisor-launch.test.ts` (RED → GREEN) | **16/2/51** → **18/0/53** |
| core `session-revert-principal` | **5/0/18** |
| core revert+launch+process-guard+ripgrep+tool-bash | **33/0/113** |
| core read-batch-context + `session-direct-read-batch` | **27/0/447** |
| server `session-revert-authorization` | **7/0/45** |
| `tsgo --noEmit` core / server / sdk-next / client | **0 / 0 / 0 / 0** |
| `codemode/test/openapi.test.ts` · `httpapi-codegen/test/generate.test.ts` | **26/0/138** · **60/0/113** |
| `audit_markdown_repo.py` · `validate_convergence.py` | **ACTIVE_BLOCKERS 0** · **1300/0** |

Pre-existing, **not mine**: `session-supervisor-discovery.test.ts` "validates discovery depth…" fails
`1/0/10` in isolation — the tested `repoDiscoveryPageMatchesRequest` sits at `supervisor.ts:145`,
outside **every** uncommitted hunk (62 hunks start at ≥504), the test is tracked and unmodified, and it
exercises none of my code; its schema dependency `packages/schema/src/repo-intelligence-v1.ts` is
modified by another owner.

No Cargo, no Rust, no provider/network, no Git write. Leftovers: the temporary
`packages/client/.p1-portability-probe.ts` was deleted; `.gitignore` untouched; no worktree/process.
Both terminal readiness flags **false**. P1 remains **PHASE_PARTIAL / NOT VERIFIED / NOT RELEASED**.
