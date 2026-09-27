# TODO — HorizonCode Delivery Tracker

Delivery tracker only. Design authority is `ARCH/`. Phases come from `DEC-001`; each phase must ship a measurable differentiator before the next begins.

## Status vocabulary

| Status | Meaning |
|---|---|
| **done** | The listed work exists in the committed tree **and** the evidence column names something that proves it. Evidence must be a named test or a measured result — never a file's existence alone. |
| **in progress** | Part of the listed work exists; a named part of the task is missing or unproven. The missing part is stated. |
| **not started** | No implementation for this task exists in the tree. |

"done" here means **implemented and test-covered**, never **accepted**. Acceptance is
evidence-gated (`ARCH/23`): no `ACC-P1-*` record exists yet, so every readiness claim in
this tracker is `implemented`, and `REQ-VER-015` labelling applies to all of it.

**Status provenance.** The original phase rows were assessed at `aee1e0b`; the
current HEAD on 2026-09-27 is `dacca604` with additional pre-existing, uncommitted
source changes. Thus a historical `done`/`not started` row below is not an executed
verdict for today's worktree unless its evidence cell says so. A source inspection for
this architecture pass found `horizoncode-audit` and `horizoncode-analytics` present, but ran no
tests and produced no `ACC-P1-*` acceptance record. Reconcile every row against a
clean revision and retained evidence before claiming acceptance (`AX-325`).

## P0 — Skeleton that runs inside an ACP editor (weeks 0–3)

Target: an ACP client drives a real turn with streamed tool calls; sessions are portable and replayable.

| ID | Task | Status | Evidence | Refs |
|---|---|---|---|---|
| `AX-001` | Initialize Rust workspace, crates, CI, license allowlist gate | in progress | `81eeb2c` — workspace + 9 crates, `rust-toolchain.toml`, `rustfmt.toml`, workspace lints (`unsafe_code = "forbid"`). **Missing:** no CI configuration and no license-allowlist gate in the tree (`git ls-files` matches neither) | `DEC-002`, `DEC-012` |
| `AX-002` | Event-sourced session store + append-only JSONL log | done | `81eeb2c` — `crates/horizoncode-session/tests/log.rs`, 8 tests: `create_append_and_replay_round_trips_history`, `resume_after_reopen_replays_identically`, `interrupted_turn_is_repaired_deterministically`, `torn_final_line_is_discarded`, `unknown_event_type_is_a_typed_failure`, `missing_session_is_not_found`, `list_and_latest_are_ordered_by_activity`, `close_is_idempotent_and_marks_status` | `DEC-004` |
| `AX-003` | Runner skeleton: admission → model step → continuation | done | `81eeb2c` — `crates/horizoncode-runner/tests/e2e_loop.rs`, 5 tests: `loop_executes_a_tool_call_then_returns_the_final_answer`, `loop_retries_a_transient_provider_failure`, `loop_terminates_interrupted_when_cancelled`, `loop_disables_tools_on_the_last_step`, `resume_continues_from_the_replayed_log` | `REQ-LOOP-001..006` |
| `AX-004` | Read-only tools: read, glob, grep, list | done | `81eeb2c` — `crates/horizoncode-tools/tests/tools.rs`, 13 tests; the four builtins exist under `crates/horizoncode-tools/src/builtin/` | `REQ-TOOL-001..005` |
| `AX-005` | One HTTP chat-completion provider transport + executor retries | done | `81eeb2c` — `crates/horizoncode-provider/tests/mock_transport.rs`, 4 tests (`streams_text_and_finishes`, `assembles_streamed_tool_call_arguments`, `auth_failure_is_terminal_and_classified`, `rate_limit_is_retried`); 20 unit tests across `compatible.rs`, `retry.rs`, `sse.rs`, `redact.rs`, `secret.rs` | `REQ-PROV-001..004` |
| `AX-006` | ACP stdio server: session lifecycle + streamed updates | done | `81eeb2c`, aligned to `DEC-023` by `9e3071d`/`aee1e0b` — `crates/horizoncode-cli/tests/e2e_acp.rs`, 2 tests driving the **built binary** over stdio: `initialize` handshake, session create, streamed `session/update`, `session/request_permission`, terminal prompt response. **Deferred to P1:** the `ACC-P1-05` generated method-coverage diff | `REQ-PROTO-001..002` |
| `AX-007` | Headless `-p` run mode (default + JSON) | done | `81eeb2c` — `crates/horizoncode-cli/tests/e2e_binary.rs`, 4 tests: `headless_one_shot_prints_the_final_answer`, `headless_json_format_streams_ndjson_events`, `continue_resumes_the_most_recent_session`, `missing_configuration_exits_with_the_config_code`; the exit-code table lives in `args.rs` `EXIT_CODES_HELP`. **Deferred to P1:** the `ACC-P1-08` test that fails when the table and `--help` disagree | `REQ-PROTO-005` |
| `AX-008` | Config discovery + `AGENTS.md` instruction context | not started | No `horizoncode-config` crate; no `AGENTS.md` discovery in the tree. `HORIZONCODE_BASE_URL`/`API_KEY`/`MODEL`/`HOME` are read directly from the environment in `crates/horizoncode-cli` | `REQ-CTX-005` |
| `AX-009` | Minimal TUI transcript + fixed composer dock | not started | No TUI crate; no terminal-rendering dependency in the workspace `Cargo.toml` | `REQ-UI-002..004` |
| `AX-010` | Generate + ship the `THIRD-PARTY-NOTICES` bundle (upstream role, pinned commits, licenses, copyright lines) | not started | No notices file and no generator in the tree | `DEC-011`, `DEC-012`, `REQ-SEC-001` |

**Exit:** ACP-driven turn with streamed tool calls, replayable session log. **State: the exit behaviour is implemented and test-covered; `AX-001` (CI + allowlist gate), `AX-008`, `AX-009`, and `AX-010` are not.**

## P1 — Safe agent you can trust (weeks 3–8)

Target: end-to-end coding task in a sandbox with guard + verified audit.

| ID | Task | Status | Evidence | Refs |
|---|---|---|---|---|
| `AX-101` | Full tool plane: write, edit, apply-patch, shell | done | `aee1e0b` — `crates/horizoncode-tools/tests/mutations.rs`, 10 tests: `write_creates_and_overwrites`, `write_refuses_workspace_escape`, `edit_requires_a_unique_match`, `apply_patch_adds_updates_and_deletes`, `apply_patch_reports_a_non_matching_hunk`, `todo_state_is_maintained_per_session`, `bash_runs_inside_the_sandbox`, `bash_without_a_sandbox_is_unavailable`, `a_deny_rule_blocks_a_write_and_removes_the_tool`, `plan_mode_refuses_a_mutating_call`; plus `crates/horizoncode-cli/tests/e2e_tools.rs`, 3 end-to-end tests. **Known gap:** `apply_patch` has no atomicity claim or test — see Open defects | `REQ-TOOL-001` |
| `AX-102` | Sandbox tier 1 (Linux/macOS): `SandboxProvider` tier; Linux declares `enforced` as the network guarantee level it must prove, and the mechanism is stated as what is actually installed — **namespace isolation** (`bwrap --unshare-all`, network namespace off) with Landlock/seccomp stacking still pending, which is **not** syscall-level denial; macOS declares `best_effort` with its residual; workspace-scoped reads *and* writes on both | in progress | `aee1e0b` — `crates/horizoncode-sandbox/tests/sandbox.rs`, 11 tests: `workspace_write_allows_inside_and_refuses_outside`, `workspace_write_denies_network_by_default`, `read_only_profile_refuses_workspace_writes`, `deny_glob_hides_content_and_writes`, `check_path_enforces_writable_roots_and_protection`, `allowlist_network_is_refused_not_opened`, `unsupported_backend_refuses_confined_effects`, `unsupported_backend_runs_bare_only_for_full_access`, `missing_backend_binary_is_unavailable`, `full_access_runs_bare`, `timeout_kills_a_long_running_command`. **Missing:** Landlock/seccomp, and the `ACC-P1-01` acceptance record for the tier | `DEC-008`, `DEC-026`, `DEC-027`, `REQ-GUARD-004` |
| `AX-103` | Policy guard: ordered rules, fail-closed, approval lifecycle | done | `aee1e0b` — `crates/horizoncode-guard/tests/guard.rs`, 12 tests: `find_last_wins_within_a_layer`, `unmatched_actions_fail_closed`, `unmatched_may_be_ask_but_never_allow`, `outer_deny_ceiling_cannot_be_widened_by_a_session_allow`, `malformed_config_fails_closed`, `plan_mode_blocks_mutating_actions_and_allows_reads`, `yolo_allows_ask_but_never_the_catastrophic_gate_or_explicit_deny`, `ticket_scope_ttl_and_single_use`, `materialize_filter_removes_plan_mode_mutating_tools`, `saved_rule_takes_effect_and_persists`, `project_config_overrides_global_nearest_wins`, `approval_resolvers_are_fail_closed_by_default`. **Deferred:** the committed `ACC-P1-02` decision table | `DEC-005`, `REQ-GUARD-001..003` |
| `AX-104` | Audit log: hash chain + verification command + redaction | in progress | `crates/horizoncode-audit/` and `crates/horizoncode-cli/src/surfaces.rs` exist at `dacca604`; prior `CURRENT_RUN.md` reports earlier tests. **Missing:** current-worktree acceptance, stable per-effect prepare/terminal receipts, and runtime completeness reconciliation (`AX-311`). Source presence is not acceptance. | `DEC-005`, `DEC-031`, `REQ-AUDIT-001..005` |
| `AX-105` | Secret broker + never-log guarantees | in progress | `aee1e0b` — `SecretString` with a redacting `Debug` (+1 unit test) and `Redactor` (4 unit tests) in `crates/horizoncode-provider/src/`. **Missing:** no `CMP-secrets` crate, no keyring/OS-credential custody, no use-style injection API | `REQ-PROV-004` |
| `AX-106` | MCP host: stdio + streamable HTTP, per-session dedupe | not started | No `horizoncode-mcp` crate | `REQ-PROTO-003` |
| `AX-107` | Multi-provider + catalog fetch/cache (curated primary, opt-in enrichment — no bundled offline snapshot; `DEC-021`) | not started | Exactly one adapter ships (`ChatCompletionsProvider`); no catalog, no cache, no provenance record, no `catalog refresh`. **Also:** the task's previous "offline snapshot" wording and the source-ledger hard-gate bullet still need reconciling with `DEC-021` — see Open defects | `DEC-007`, `DEC-021`, `REQ-PROV-002` |
| `AX-108` | `ratatui` TUI: overlays, permission modal, telemetry | not started | No TUI crate; no `ratatui` dependency | `REQ-UI-*` |
| `AX-109` | Analytics ledger + usage/insights/stats/export surfaces | in progress | `crates/horizoncode-analytics/` and CLI usage/insights surfaces exist at `dacca604`; prior `CURRENT_RUN.md` reports earlier tests. Current-worktree acceptance and UI/peer cost integration are still unproven. | `DEC-017`, `REQ-ANALYTICS-001..006` |
| `AX-110` | Skills: discovery + description routing + progressive disclosure | not started | No skills discovery in the tree | `REQ-SKILL-001..004` |
| `AX-111` | Plugins + hooks: manifest, enumeration, disabled by default | not started | No plugin/hook surface in the tree | `DEC-018`, `REQ-PLUGIN-001..004` |
| `AX-112` | ACP client mode: drive peer agents as subordinates | not started | `crates/horizoncode-acp/` contains only the server side (`server.rs`, `observer.rs`, `permission.rs`, `error.rs`); no client/spawn/reconnect code | `DEC-019`, `REQ-PROTO-004/006` |
| `AX-113` | Windows containment tier: AppContainer + restricted token/job objects + acceptance tests (network level declared as `capability` — deny-by-absence, not a syscall filter; job objects do not deny network; honest limits, not equivalent to Landlock/seccomp) | in progress | `aee1e0b` — `crates/horizoncode-sandbox/src/windows.rs` compiles with the AppContainer/restricted-token/job-object profile and an honest declared level. **Missing:** the backend is **untested on this host**, and the tier's `ACC-P1-01` record does not exist | `DEC-008`, `DEC-026`, `DEC-027`, `REQ-GUARD-004` |
| `AX-114` | macOS Seatbelt sandbox backend + acceptance tests; `file-read*` grants scoped to granted-root subpath allows; network level declared as `best_effort` with its residual, and a caller requiring `enforced` is refused | in progress | `aee1e0b` — `crates/horizoncode-sandbox/src/macos.rs` compiles and declares `best_effort` with its residual. **Missing:** the backend is **untested on this host**, and the tier's `ACC-P1-01` record does not exist | `DEC-008`, `DEC-026`, `DEC-027`, `REQ-GUARD-004` |
| `AX-307` | Eval harness: paired per-task A/B (k ≥ 3), pre-registered endpoints + published benchmark suite — pulled-forward prerequisite for all eval-gated features | not started | No eval harness in the tree. This is the prerequisite for `AX-203` and `AX-206`; a gate that cannot run when a feature lands is not a gate (`DEC-016`, `REQ-VER-018`) | `DEC-016`, `REQ-CTX-003/006/009`, `REQ-HORIZON-*` |
| `AX-115` | Security hardening pass 1: canonicalize-and-re-validate every fs target (TOCTOU), argv-only spawn with env allowlist, resolve-then-check egress with per-hop re-authorization, project-scope narrowing-only config validation, bash argument-path extraction into guard `fs.*` resources + external-directory floor rule, per-tier read scoping to granted roots | in progress | `aee1e0b` — **present:** argv-based spawn with a child env allowlist (`crates/horizoncode-tools/src/builtin/bash.rs`, `crates/horizoncode-sandbox/src/process.rs`), per-tier read/write scoping and deny-glob materialization (`crates/horizoncode-sandbox/src/paths.rs`, checked by `workspace_write_allows_inside_and_refuses_outside`, `check_path_enforces_writable_roots_and_protection`, `write_refuses_workspace_escape`). **Missing:** canonicalize-and-re-validate at use (TOCTOU close), the mediated egress layer with resolve-then-check and per-hop re-authorization, the `external_directory` floor rule, and bash argument extraction into `fs.*` resources — `registry.rs` `resources_from_input` still pushes the raw `path`/`command` string as a resource rather than extracting `fs.*` (`DEC-024`, `DEC-025`) | `ARCH/22`, `REQ-SEC-004..008`, `REQ-SEC-019/022`, `REQ-SEC-025`, `DEC-024/025` |
| `AX-116` | Secret non-disclosure: redaction before all persistence (incl. external text), no-`Debug` secret types, redacting panic hook, canary-corpus scan over prompts/errors/audit/analytics/TUI/exports | in progress | `aee1e0b` — **present:** `SecretString` has no `Display` and a redacting `Debug`; `Redactor` runs before persistence in the provider path. **Missing:** no redacting panic hook (no `std::panic::set_hook` in the tree), no canary-corpus scan, and redaction is not yet applied over audit/analytics/TUI/export because those components do not exist | `ARCH/22`, `REQ-SEC-009` |
| `AX-117` | Audit hardening: declared anchoring level, rendered claim boundary, cross-process append lock, and reconciliation incident | in progress | Audit crate exists at `dacca604`; exact current-worktree anchoring/lock behavior and acceptance remain unverified. Per-effect completeness is tracked by `AX-311`. | `ARCH/22`, `ARCH/14`, `DEC-022`, `REQ-AUDIT-004/007`, `REQ-SEC-012/020/024` |
| `AX-118` | Guard hardening: `unmatched: "allow"` rejected at schema load, non-canonical resource refusal, composed reduced-safety acknowledgement, guard↔sandbox pattern parity corpus | in progress | `aee1e0b` — **present:** `unmatched: "allow"` is rejected at load (`unmatched_may_be_ask_but_never_allow`, `malformed_config_fails_closed`), the catastrophic gate is irreducible (`yolo_allows_ask_but_never_the_catastrophic_gate_or_explicit_deny`), and ticket scope/TTL/single-use are validated (`ticket_scope_ttl_and_single_use`). **Missing:** refusal of a non-canonical resource, the single composed reduced-safety acknowledgement, and the guard↔sandbox pattern parity corpus | `ARCH/22`, `ARCH/12`, `REQ-SEC-021`, `REQ-GUARD-002` |
| `AX-119` | Extension hardening: normalized file-set pin digest, bounded/confined package-extraction budgets, extension processes confined with ambient network denied **at the confinement tier's declared `network_guarantee_level`** (level, mechanism, and residual recorded in the extension's acceptance record and surfaced wherever its profile is presented; a caller requiring a stronger level is **refused**, never downgraded), hook tighten-only enforcement | not started | No extension plane exists yet, so nothing is implemented; the task is also the tracker for `DEC-027`'s third governed item | `ARCH/22`, `DEC-018`, `DEC-026`, `DEC-027`, `REQ-SEC-015/016` |
| `AX-120` | Multi-agent authority: parent-ceiling intersection asserted at spawn and per effect, peer requests re-authorized locally, approvals bound to (peer, tool, resource) | not started | No `CMP-orch` crate and no peer-spawn code | `ARCH/22`, `ARCH/16`, `REQ-SEC-014`, `REQ-ORCH-001/005` |
| `AX-121` | Architecture gates in CI: no effect path without guard+audit, no policy evaluation outside the guard, no path-policy evaluation outside the guard, `exec.run` resources are command-prefix only (a path-shaped `exec.run` rule is rejected at load), no direct network client above the egress adapter, brand-name scan over shipped artifacts | not started | No CI configuration exists (`AX-001`), so no gate runs. The rules themselves are specified and unimplemented | `ARCH/22`, `ARCH/23`, `DEC-025`, `REQ-SEC-023`, `REQ-SEC-025`, `REQ-VISION-003` |
| `AX-122` | Verification harness: injectable clock/ids/rng/home, mock provider transport, loopback-only HTTP with a non-loopback tripwire, 5×/20× repeat policy, quarantine ledger, fuzz targets for untrusted formats | in progress | `aee1e0b` — **present:** a mock provider transport (`crates/horizoncode-provider/src/testing.rs`, `MockServer`/`MockTurn`) exercised by 4 contract tests and by the E2E suites, plus injectable identifier sources (`crates/horizoncode-types/src/ids.rs`, 3 tests) and a per-test `HORIZONCODE_HOME`. **Missing:** no injectable clock or seeded RNG, no loopback tripwire wrapper, no repeat/quarantine ledger, no fuzz targets | `ARCH/23`, `REQ-VER-002..004`, `REQ-VER-016` |
| `AX-123` | P1 acceptance matrix `ACC-P1-01..08`: containment per tier, guard decision table, ACP approval round-trip, audit verify + census, ACP handshake, replay/resume determinism, compaction continuity, headless exit codes | not started | No `ACC-P1-*` record or evidence root exists. Partial preconditions are green (containment, guard, replay, headless are unit/E2E covered), but a unit or mock result is explicitly **not** acceptance evidence (`REQ-VER-015`) | `ARCH/23`, `REQ-VER-005..011`, `REQ-VER-013..015` |
| `AX-124` | Performance baseline harness: repeatable benchmark procedure with a recorded machine baseline; provisional budgets replaced by measured values; `unmeasured` as a first-class verdict | not started | No benchmark harness and no recorded machine baseline | `ARCH/23`, `REQ-VER-012` |
| `AX-125` | Fail-closed resource bounds: session/run ceilings for steps, tool calls, wall-clock, tokens, cost, output bytes, concurrency; tree totals capped by the session ceiling; unknown pricing fails closed on the cost term | in progress | `aee1e0b` — **present:** `max_steps` with last-step tool disabling and wrap-up (`loop_disables_tools_on_the_last_step`), a per-turn token ceiling that **fails closed** (`loop_terminates_interrupted_when_cancelled`; `runner.rs` returns `TurnEndStatus::Failed` on exhaustion), `max_parallel_tools`, and `max_output_tokens` in `crates/horizoncode-runner/src/config.rs`. **Missing:** tool-call count, wall-clock, cost, and session-total output-byte ceilings; no tree-total cap; no pricing table, so no cost term | `ARCH/22`, `REQ-SEC-013`, `REQ-HORIZON-003` |
| `AX-126` | Local state integrity: state/config/cache ownership+mode validation, no-follow/exclusive-create lock/head/temp files, symlinked policy/config path refusal, portable-bundle verify-before-trust | not started | The session store creates its root (`crates/horizoncode-session/src/store.rs`) but performs **no** ownership or mode validation, uses plain `OpenOptions` for append, and no lock/head/temp file exists | `ARCH/22`, `ARCH/07`, `REQ-SEC-018/019` |

**Eval gate prerequisite:** `AX-307` ships in this phase so the P2 eval-gated features
(`AX-203`, `AX-206`) are gated by a harness that already exists when they are built —
a gate cannot be satisfied retroactively. The gating requirement is unchanged; only
its tooling moves earlier. **Currently not started, so the P2 gate has no harness.**

**Security/verification prerequisite:** `ARCH/22-SECURITY.md` and
`ARCH/23-VERIFICATION.md` define the threat model and the evidence rules for this
phase. `AX-115..AX-126` are not polish: `AX-122` (verification harness) and `AX-123`
(the `ACC-P1-01..08` acceptance matrix) are what turn "it works" into evidence, and
they ship **in this phase** for the same reason `AX-307` does. **Both are open, so no
P1 exit claim is currently evidence-backed.**

**Exit:** guarded, sandboxed, audited coding task; policy changes behavior with no code
change; the `ACC-P1-01..08` acceptance matrix passes with retained records.
**Differentiator: guard + verifiable audit.** *Status: the guard half is implemented and
test-covered; the audit half (`AX-104`, `AX-117`) does not exist, and the acceptance
matrix has not been run.*

## P2 — Context that survives scale + routing (weeks 8–16)

| ID | Task | Status | Evidence | Refs |
|---|---|---|---|---|
| `AX-201` | Tree-sitter repo map + reference-graph ranking | not started | No `horizoncode-context` crate; no parsing dependency | `DEC-006`, `REQ-CTX-001` |
| `AX-202` | LSP symbols + SCIP ingest | not started | No `horizoncode-context` crate | `REQ-CTX-001` |
| `AX-203` | Eval-gated compaction (tail + summary + retrieval eval) | not started | Blocked on `AX-307` | `DEC-006`, `DEC-016`, `REQ-CTX-002..004/009`, `AX-307` |
| `AX-204` | Sub-agents: worktree isolation, receipts, depth/count bounds | not started | No `CMP-orch` crate | `REQ-ORCH-001..002/005` |
| `AX-205` | Merge arbitration (deterministic) | not started | No `CMP-orch` crate | `REQ-ORCH-003..004` |
| `AX-206` | Eval-gated routing + published scores | not started | Blocked on `AX-307`; one provider adapter ships with no router | `DEC-007`, `DEC-016`, `REQ-PROV-005`, `AX-307` |
| `AX-207` | Checkpoint + rewind | not started | No checkpoint/rewind in `crates/horizoncode-session` | `REQ-SESS-003` |
| `AX-208` | Worktree cockpit: dockable pane + tree + diffs + embedded editor | not started | No TUI crate | `DEC-010`, `REQ-UI-005..006` |

**Exit:** >50-file cross-repo task without context loss; routing beats a single-frontier baseline on the published suite. **Differentiator: cross-repo context + transparent routing.**

## P3 — Long-horizon + self-hosted orchestration (weeks 16–24)

| ID | Task | Status | Evidence | Refs |
|---|---|---|---|---|
| `AX-301` | Durable task graph surviving compaction/restart | not started | No task-graph component | `DEC-009`, `REQ-HORIZON-002` |
| `AX-302` | Budgets: token/cost/wall-clock, fail closed | not started | Token ceiling only, and it is per-turn (`AX-125`); no cost or wall-clock term | `REQ-HORIZON-003` |
| `AX-303` | Parallel self-hosted team orchestration + CI feedback loop | not started | No `CMP-orch` crate | `REQ-ORCH-*` |
| `AX-304` | ACP multi-agent orchestration hardening (supervised peer pool) | not started | No ACP client mode (`AX-112`) | `DEC-019`, `REQ-PROTO-004` |
| `AX-305` | Local/offline models | not started | One hosted-style adapter only | `REQ-PROV-001` |
| `AX-306` | Sandboxed WASM skills/plugins | not started | No skills/plugin plane and no WASM runtime | `DEC-008` |
| `AX-308` | Skills curator lifecycle (usage telemetry, archive-not-delete) | not started | No skills plane | `REQ-SKILL-*` |

(`AX-307`, the eval harness, was pulled forward to P1; see the Eval gate prerequisite note.)

**Exit:** N agents work a real backlog in parallel, auto-merge clean work, surface conflicts with evidence. **Differentiator: open parallel orchestration.**

## Architecture-driven delivery slices (2026-09-27)

These are implementation tasks, not verified outcomes. `ARCH/24` gives source-backed findings; `ARCH/25` gives the contract. Each task is `not started` for this **new acceptance contract** even if a related crate exists. Dependencies are explicit; completion requires code on an exact revision, a regression/acceptance record under `ARCH/23`, and a review of negative cases. Work may proceed in parallel only where write scopes and dependencies permit.

| ID | Bounded output and acceptance | Depends on | Priority |
|---|---|---|---|
| `AX-309` | Versioned run/task/attempt/spec/evidence events and rebuildable SQLite projections. Crash replay yields identical task state and rejects newer schema before partial decode. | `AX-325` | P0 |
| `AX-310` | One controller in `CMP-orch`; only independently verified `PASS` tied to spec and commit unlocks descendants. Prove worker `completed`, missing evidence, stale evidence and dependency cycle cannot complete a run. | `AX-309`, `AX-317` | P0 |
| `AX-311` | Effect-intent journal with stable IDs, prepare/terminal receipts, audit/session reconciliation, and idempotent external retry. Inject crashes between prepare, effect and receipt; no duplicate PR/write or silent unknown outcome. | `AX-309`, `AX-104` | P0 |
| `AX-312` | Atomic hierarchical budget reservations for run/task/attempt, including verification/recovery reserve. Concurrent dispatch never exceeds a parent ceiling; unknown price is typed. | `AX-309` | P0 |
| `AX-313` | Fenced workspace leases and stable merge order; stale worker write refused after takeover, merged revision retested, conflicts retained as evidence. | `AX-309`, `AX-310` | P0 |
| `AX-314` | Multi-file patch preflight/staging or explicit crash-safe partial-effect journal. A later bad hunk leaves no unreported earlier edit; symlink/base-hash races refuse. | `AX-311` | P0 |
| `AX-315` | Shell-script execution contract: exact script shown/authorized, explicit `/bin/sh -c` semantics, child env filter, confinement and audit. Injection fixtures prove no accidental string concatenation around script/args. | `AX-311` | P0 |
| `AX-316` | Four-value network-guarantee type and per-tier proof; app HTTP egress separate from child confinement, no silent proxy bypass, tier-specific `ACC-P1-01` record. | `AX-122`; feeds `AX-123` | P0 |
| `AX-317` | Original intent, assumptions, clarifications and immutable spec revisions; a changed user-visible requirement invalidates affected task and evidence graph. | `AX-309` | P0 |
| `AX-318` | ACP and CLI external-attempt adapters with capability snapshot, event cursor, usage provenance, cancel/reconnect, opaque nested-agent disclosure, and worktree reconciliation. | `AX-310`, `AX-313` | P1 |
| `AX-319` | One context projection order and instruction precedence; cache-prefix and context-epoch conformance fixtures across model switch and compaction. | `AX-307` | P1 |
| `AX-320` | Commit/file-digest-bound repo index and task context package, lexical fallback, stale LSP/symbol-edit refusal, and impact/test pointers. | `AX-309` | P1 |
| `AX-321` | Runtime capability probe and dependency manifest for sandbox/Git/LSP/local runtime/detached mode; unsupported feature refuses with precise guidance. | `AX-316` | P1 |
| `AX-322` | Governed external-editor handoff and versioned symbol-edit contract alongside embedded editor; large-file edit path remains reviewable. | `AX-320` | P2 |
| `AX-323` | Typed settings and run status across TUI/headless/ACP: themes/colours/accessibility, model/agent, compaction, budget, cost provenance and effective policy source. User can change allowed values and see when they apply. | `AX-310`, `AX-312`, `AX-324` | P1 |
| `AX-324` | Curated model registry with provenance, opt-in refresh, truthful price/quota display, and pinned eval fixtures; no catalog-directed endpoint/auth. | `AX-307` | P1 |
| `AX-325` | Reconcile `TODO.md`, `CURRENT_RUN.md`, README and traceability rows to clean HEAD and existing acceptance artifacts; remove stale absence/HEAD claims. | none | P0 |
| `AX-326` | PR lifecycle with governed create/comment/merge, idempotency, diff/review/CI on exact head, and retry reconciliation. | `AX-311`, `AX-313`, `AX-310` | P1 |
| `AX-327` | Local inference conformance matrix per server/model/template for tool calls, streaming, cancellation, context and usage; required capability absent ⇒ route refusal. | `AX-324`, `AX-307` | P1 |
| `AX-328` | Known-secret custody and canary scans across prompt, tool, audit, analytics, TUI and export; document unknown workspace-secret residual. | `AX-311` | P0 |
| `AX-329` | Security config load refuses parse/read errors or retains a signed safe snapshot with stale warning; no silent broader grant. | `AX-309` | P0 |
| `AX-330` | Same-model, same-task, same-budget multi-hour benchmark against a single-agent baseline, with crash/spec-change/peer-disconnect cases and published failure data. | `AX-307`, `AX-310`, `AX-311`, `AX-313`, `AX-318`, `AX-320` | P1 |
| `AX-331` | Supervised detached controller and authenticated attach/replay API. Disconnect TUI during a multi-hour task, reconnect by cursor, inject cursor gap and process crash, and show last-confirmed state accurately. | `AX-309`, `AX-310`, `AX-321` | P1 |
| `AX-332` | Permission-filtered, token-budgeted on-demand MCP/plugin tool schemas, pinned by digest for a model step. Catalog refresh cannot rebind an in-flight call. | `AX-319`, `AX-307` | P1 |
| `AX-333` | Conformance-gated text edit formats for local/model-specific routes; all-file preflight, bounded repair feedback, and command/revision-bound lint/test evidence. | `AX-314`, `AX-327` | P1 |

**Exit rule:** `AX-330` measures verified completion, intent alignment, recovery success, duplicate-work cost, premature completion, and cost per verified deliverable. A capability may be implemented before this gate but cannot be described as superior to peer agents without the comparative record. Staging above is an engineering dependency order; the full intended capability set remains in scope.

## Open defects

**Current review (2026-09-27).** `ARCH/24-ARCHITECTURE-REVIEW.md` records 29 design/source findings with evidence and ownership. In particular, `AX-104`/`AX-109` are no longer absent, the `DefaultHasher` finding below has been changed to BLAKE3 in the current uncommitted guard source (`guard.rs:949-968`), and the `session_store()`/`OnceLock` item is a stale phantom per `CURRENT_RUN.md`. Neither should be re-opened without current source evidence. The old numbered list below is retained as a historical snapshot pending `AX-325`; it is **not** a list of all current defects.

Known, still-unfixed. Each is a real gap in the committed tree or in a lane currently
in flight; none is closed.

1. **`session_store()` `OnceLock` writability probe makes the CLI suite order-dependent.**
   A bare `cargo test -p horizoncode-cli` without the `testing` feature bakes in an
   unwritable home and breaks a later workspace E2E run. An update to this is **in
   flight**. *Note:* the symbol `session_store` and any writability probe do **not**
   appear in the committed tree at `aee1e0b`, so this cannot be reproduced from HEAD
   alone — it is a finding against in-flight work. Verify against the tree that lands
   next before treating it as a HEAD defect.
2. **`Guard::policy_hash` used a non-cryptographic `DefaultHasher`.** The policy digest
   is computed with `std::collections::hash_map::DefaultHasher`
   (`crates/horizoncode-guard/src/guard.rs`, `compute_policy_hash`) and is stored on every
   ticket, so it is not collision-resistant and cannot be treated as a cryptographic
   binding. An update is **in flight**.
3. **`apply_patch` has no atomicity claim yet.** The tool applies add/update/delete
   hunks and reports a non-matching hunk
   (`crates/horizoncode-tools/tests/mutations.rs`), but nothing states or tests whether a
   partially-applied patch is possible on a mid-patch failure. `ARCH/22` `F-03` assumes
   a governed atomic write path; that assumption is currently unverified for this tool.
4. **The `question` tool is not exposed over ACP.** `crates/horizoncode-tools/src/builtin/question.rs`
   ships and the registry gates it behind an interactive handler, but
   `crates/horizoncode-acp/` maps no tool name to it, so an ACP client cannot reach it.
5. **macOS and Windows sandbox backends compile but are untested on this host.** Linux
   enforcement is **namespace isolation** (`bwrap --unshare-all` with the network
   namespace off); **Landlock and seccomp are not installed in this environment**, so
   namespace isolation is the actual enforcement and **must not be described as
   equivalent to syscall-level denial**. The macOS Seatbelt and Windows
   AppContainer/restricted-token backends have no executed test on this host at all.
6. **Container and remote sandbox tiers are not built.** `crates/horizoncode-sandbox/src/unsupported.rs`
   refuses them; no OCI or remote provider exists, so the "every tier that advertises
   support" parity run in `ARCH/23` has nothing to run against.
7. **The model-catalog license is confirmed MIT, but wording still predates that.**
   `DEC-021` closes the `SRC-009` data-license hard gate and sets the catalog posture
   (curated primary + opt-in enrichment, no full-dataset snapshot by default).
   `ARCH/05`'s pre-existing hard-gate bullet and `AX-107`'s "offline snapshot" wording
   still need reconciling with `DEC-021`; `ARCH/22` `X-09`/`RR-06` and `REQ-SEC-017` are
   already aligned. `AX-107`'s task row above is reworded; the ledger bullet is not.

## Open decisions

- **Resolved:** the exact model-catalog source and its data license. `DEC-021` closes
  the `SRC-009` data-license hard gate: the license is permissive (MIT), confirmed from
  primary sources, and the posture is a small curated primary catalog with per-row
  provenance plus opt-in runtime enrichment, with no bundled full-dataset snapshot and
  no third-party marks (`ARCH/05` §5, `ARCH/11`).
- Resolved: worktree cockpit layout is specified in `ARCH/06-UI.md` (`DEC-010`); implementation tracked as `AX-208`.
- Extension trust policy (pin format, allow/deny + managed lockdown) is specified in `ARCH/21-DISCOVERY.md`; the exact pin hash format is still open.
- **Audit anchoring (resolved):** `DEC-022` settles the open question. Roots are always signed; the default anchoring level is `local-sink` (a validated append-only sink outside the audit store root); `off-box` is required for any deployment that declares an off-box trust requirement; a configured-but-unreachable sink **fails closed**; `local-trust` survives only as an explicit, acknowledged, labeled posture. `REQ-AUDIT-004` was reworded (not lowered) and the claim boundary is separately testable under `REQ-AUDIT-007`. Residual — fabrication and the unanchored tail are not detected by any local anchor — stays in `ARCH/22` `RR-02`/`RR-03`. Implementation tracked as `AX-117`; device-key rotation/escrow remains open (`ARCH/14` Open question 1).
- **Protocol naming (resolved):** `DEC-023` fixes the canonical, frozen ACP permission method token as `session/request_permission`; no alias is accepted and `request/permission` is not a transition form. `ARCH/15` and `REQ-PROTO-002` are aligned; `ACC-P1-03`/`ACC-P1-05` were already specified against it.
- **Per-tier network levels (resolved, then read through):** `DEC-026` introduced the
  guarantee levels and `DEC-027` is the formal read-through of `DEC-008`..`DEC-026`:
  "network off" is the *request* a profile makes, and the tier's declared
  `network_guarantee_level` is what is *enforced*. Linux `enforced` remains the
  required level for any profile advertised as network-restricted; a tier that cannot
  meet a required level **refuses** rather than degrading. `DEC-008`'s wording is
  unchanged. Governs `REQ-VER-005`, `REQ-SEC-016`, `REQ-SEC-008`, `AX-102`, `AX-119`.
- **Flagged for the owning lane:** the license-allowlist gate and CI (`AX-001`, `AX-121`) have no implementation, so `G-1`, `G-3`, `G-9`, and `G-10` cannot be evaluated at all.
