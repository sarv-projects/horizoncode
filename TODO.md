# TODO — agentX Delivery Tracker

Delivery tracker only. Design authority is `ARCH/`. Phases come from `DEC-001`; each phase must ship a measurable differentiator before the next begins.

## P0 — Skeleton that runs inside an ACP editor (weeks 0–3)

Target: an ACP client drives a real turn with streamed tool calls; sessions are portable and replayable.

| ID | Task | Refs |
|---|---|---|
| `AX-001` | Initialize Rust workspace, crates, CI, license allowlist gate | `DEC-002`, `DEC-012` |
| `AX-002` | Event-sourced session store + append-only JSONL log | `DEC-004` |
| `AX-003` | Runner skeleton: admission → model step → continuation | `REQ-LOOP-001..006` |
| `AX-004` | Read-only tools: read, glob, grep, list | `REQ-TOOL-001..005` |
| `AX-005` | One HTTP chat-completion provider transport + executor retries | `REQ-PROV-001..004` |
| `AX-006` | ACP stdio server: session lifecycle + streamed updates | `REQ-PROTO-001..002` |
| `AX-007` | Headless `-p` run mode (default + JSON) | `REQ-PROTO-005` |
| `AX-008` | Config discovery + `AGENTS.md` instruction context | `REQ-CTX-005` |
| `AX-009` | Minimal TUI transcript + fixed composer dock | `REQ-UI-002..004` |
| `AX-010` | Generate + ship the `THIRD-PARTY-NOTICES` bundle (upstream identity, pinned commits, licenses, copyright lines) | `DEC-011`, `DEC-012`, `REQ-SEC-001` |

**Exit:** ACP-driven turn with streamed tool calls, replayable session log.

## P1 — Safe agent you can trust (weeks 3–8)

Target: end-to-end coding task in a sandbox with guard + verified audit.

| ID | Task | Refs |
|---|---|---|
| `AX-101` | Full tool plane: write, edit, apply-patch, shell | `REQ-TOOL-001` |
| `AX-102` | Sandbox tier 1 (Linux/macOS): `SandboxProvider` tier; namespaces + Landlock + seccomp (Linux), network off, workspace writes | `DEC-008`, `REQ-GUARD-004` |
| `AX-103` | Policy guard: ordered rules, fail-closed, approval lifecycle | `DEC-005`, `REQ-GUARD-001..003` |
| `AX-104` | Audit log: hash chain + verification command + redaction | `DEC-005`, `REQ-AUDIT-001..003` |
| `AX-105` | Secret broker + never-log guarantees | `REQ-PROV-004` |
| `AX-106` | MCP host: stdio + streamable HTTP, per-session dedupe | `REQ-PROTO-003` |
| `AX-107` | Multi-provider + catalog fetch/cache/offline snapshot | `DEC-007`, `REQ-PROV-002` |
| `AX-108` | `ratatui` TUI: overlays, permission modal, telemetry | `REQ-UI-*` |
| `AX-109` | Analytics ledger + usage/insights/stats/export surfaces | `DEC-017`, `REQ-ANALYTICS-001..006` |
| `AX-110` | Skills: discovery + description routing + progressive disclosure | `REQ-SKILL-001..004` |
| `AX-111` | Plugins + hooks: manifest, enumeration, disabled by default | `DEC-018`, `REQ-PLUGIN-001..004` |
| `AX-112` | ACP client mode: drive peer agents as subordinates | `DEC-019`, `REQ-PROTO-004/006` |
| `AX-113` | Windows containment tier: AppContainer + restricted token/job objects + acceptance tests (network level declared as `capability` — deny-by-absence, not a syscall filter; job objects do not deny network; honest limits, not equivalent to Landlock/seccomp) | `DEC-008`, `DEC-026`, `REQ-GUARD-004` |
| `AX-114` | macOS Seatbelt sandbox backend + acceptance tests; `file-read*` grants scoped to granted-root subpath allows; network level declared as `best_effort` with its residual, and a caller requiring `enforced` is refused | `DEC-008`, `DEC-026`, `REQ-GUARD-004` |
| `AX-307` | Eval harness: paired per-task A/B (k ≥ 3), pre-registered endpoints + published benchmark suite — pulled forward prerequisite for all eval-gated features | `DEC-016`, `REQ-CTX-003/006/009`, `REQ-HORIZON-*` |
| `AX-115` | Security hardening pass 1: canonicalize-and-re-validate every fs target (TOCTOU), argv-only spawn with env allowlist, resolve-then-check egress with per-hop re-authorization, project-scope narrowing-only config validation, bash argument-path extraction into guard `fs.*` resources + external-directory floor rule, per-tier read scoping to granted roots | `ARCH/22`, `REQ-SEC-004..008`, `REQ-SEC-019/022`, `REQ-SEC-025`, `DEC-024/025` |
| `AX-116` | Secret non-disclosure: redaction before all persistence (incl. external text), no-`Debug` secret types, redacting panic hook, canary-corpus scan over prompts/errors/audit/analytics/TUI/exports | `ARCH/22`, `REQ-SEC-009` |
| `AX-117` | Audit hardening: declared anchoring level — signed roots always, `local-sink` default, `off-box` required when a trust requirement is declared, fail closed when the configured sink is unreachable, `local-trust` only as an explicit acknowledged posture; the `REQ-AUDIT-007` claim boundary rendered by `verify`; anchor level surfaced in every surface; cross-process append lock; reconciliation gap treated as an incident | `ARCH/22`, `ARCH/14`, `DEC-022`, `REQ-AUDIT-004/007`, `REQ-SEC-012/020/024` |
| `AX-118` | Guard hardening: `unmatched: "allow"` rejected at schema load, non-canonical resource refusal, composed reduced-safety acknowledgement, guard↔sandbox pattern parity corpus | `ARCH/22`, `ARCH/12`, `REQ-SEC-021`, `REQ-GUARD-002` |
| `AX-119` | Extension hardening: normalized file-set pin digest, bounded/confined package-extraction budgets, extension processes confined with network off, hook tighten-only enforcement | `ARCH/22`, `DEC-018`, `REQ-SEC-015/016` |
| `AX-120` | Multi-agent authority: parent-ceiling intersection asserted at spawn and per effect, peer requests re-authorized locally, approvals bound to (peer, tool, resource) | `ARCH/22`, `ARCH/16`, `REQ-SEC-014`, `REQ-ORCH-001/005` |
| `AX-121` | Architecture gates in CI: no effect path without guard+audit, no policy evaluation outside the guard, no path-policy evaluation outside the guard, `exec.run` resources are command-prefix only (a path-shaped `exec.run` rule is rejected at load), no direct network client above the egress adapter, brand-name scan over shipped artifacts | `ARCH/22`, `ARCH/23`, `DEC-025`, `REQ-SEC-023`, `REQ-SEC-025`, `REQ-VISION-003` |
| `AX-122` | Verification harness: injectable clock/ids/rng/home, mock provider transport, loopback-only HTTP with a non-loopback tripwire, 5×/20× repeat policy, quarantine ledger, fuzz targets for untrusted formats | `ARCH/23`, `REQ-VER-002..004`, `REQ-VER-016` |
| `AX-123` | P1 acceptance matrix `ACC-P1-01..08`: containment per tier, guard decision table, ACP approval round-trip, audit verify + census, ACP handshake, replay/resume determinism, compaction continuity, headless exit codes | `ARCH/23`, `REQ-VER-005..011`, `REQ-VER-013..015` |
| `AX-124` | Performance baseline harness: repeatable benchmark procedure with a recorded machine baseline; provisional budgets replaced by measured values; `unmeasured` as a first-class verdict | `ARCH/23`, `REQ-VER-012` |
| `AX-125` | Fail-closed resource bounds: session/run ceilings for steps, tool calls, wall-clock, tokens, cost, output bytes, concurrency; tree totals capped by the session ceiling; unknown pricing fails closed on the cost term | `ARCH/22`, `REQ-SEC-013`, `REQ-HORIZON-003` |
| `AX-126` | Local state integrity: state/config/cache ownership+mode validation, no-follow/exclusive-create lock/head/temp files, symlinked policy/config path refusal, portable-bundle verify-before-trust | `ARCH/22`, `ARCH/07`, `REQ-SEC-018/019` |

**Eval gate prerequisite:** `AX-307` ships in this phase so the P2 eval-gated features
(`AX-203`, `AX-206`) are gated by a harness that already exists when they are built —
a gate cannot be satisfied retroactively. The gating requirement is unchanged; only
its tooling moves earlier.

**Security/verification prerequisite:** `ARCH/22-SECURITY.md` and
`ARCH/23-VERIFICATION.md` define the threat model and the evidence rules for this
phase. `AX-115..AX-126` are not polish: `AX-122` (verification harness) and `AX-123`
(the `ACC-P1-01..08` acceptance matrix) are what turn "it works" into evidence, and
they ship **in this phase** for the same reason `AX-307` does.

**Exit:** guarded, sandboxed, audited coding task; policy changes behavior with no code change; the `ACC-P1-01..08` acceptance matrix passes with retained records. **Differentiator: guard + verifiable audit.**

## P2 — Context that survives scale + routing (weeks 8–16)

| ID | Task | Refs |
|---|---|---|
| `AX-201` | Tree-sitter repo map + reference-graph ranking | `DEC-006`, `REQ-CTX-001` |
| `AX-202` | LSP symbols + SCIP ingest | `REQ-CTX-001` |
| `AX-203` | Eval-gated compaction (tail + summary + retrieval eval) | `DEC-006`, `DEC-016`, `REQ-CTX-002..004/009`, `AX-307` |
| `AX-204` | Sub-agents: worktree isolation, receipts, depth/count bounds | `REQ-ORCH-001..002/005` |
| `AX-205` | Merge arbitration (deterministic) | `REQ-ORCH-003..004` |
| `AX-206` | Eval-gated routing + published scores | `DEC-007`, `DEC-016`, `REQ-PROV-005`, `AX-307` |
| `AX-207` | Checkpoint + rewind | `REQ-SESS-003` |
| `AX-208` | Worktree cockpit: dockable pane + tree + diffs + embedded editor | `DEC-010`, `REQ-UI-005..006` |

**Exit:** >50-file cross-repo task without context loss; routing beats a single-frontier baseline on the published suite. **Differentiator: cross-repo context + transparent routing.**

## P3 — Long-horizon + self-hosted orchestration (weeks 16–24)

| ID | Task | Refs |
|---|---|---|
| `AX-301` | Durable task graph surviving compaction/restart | `DEC-009`, `REQ-HORIZON-002` |
| `AX-302` | Budgets: token/cost/wall-clock, fail closed | `REQ-HORIZON-003` |
| `AX-303` | Parallel self-hosted team orchestration + CI feedback loop | `REQ-ORCH-*` |
| `AX-304` | ACP multi-agent orchestration hardening (supervised peer pool) | `DEC-019`, `REQ-PROTO-004` |
| `AX-305` | Local/offline models | `REQ-PROV-001` |
| `AX-306` | Sandboxed WASM skills/plugins | `DEC-008` |
| `AX-308` | Skills curator lifecycle (usage telemetry, archive-not-delete) | `REQ-SKILL-*` |

(`AX-307`, the eval harness, was pulled forward to P1; see the Eval gate prerequisite note.)

**Exit:** N agents work a real backlog in parallel, auto-merge clean work, surface conflicts with evidence. **Differentiator: open parallel orchestration.**

## Open decisions

- **Hard gate (open until evidenced):** the exact model-catalog source and its data license MUST be confirmed, with recorded evidence, before any catalog snapshot is vendored or committed. This gate is not closed by assumption or by a rushed snapshot (`SRC-009`, `ARCH/11` §Open questions).
- Resolved: worktree cockpit layout is specified in `ARCH/06-UI.md` (`DEC-010`); implementation tracked as `AX-208`.
- Extension trust policy (pin format, allow/deny + managed lockdown) is specified in `ARCH/21-DISCOVERY.md`; the exact pin hash format is still open.
- **Audit anchoring (resolved):** `DEC-022` settles the open question. Roots are always signed; the default anchoring level is `local-sink` (a validated append-only sink outside the audit store root); `off-box` is required for any deployment that declares an off-box trust requirement; a configured-but-unreachable sink **fails closed**; `local-trust` survives only as an explicit, acknowledged, labeled posture. `REQ-AUDIT-004` was reworded (not lowered) and the claim boundary is separately testable under `REQ-AUDIT-007`. Residual — fabrication and the unanchored tail are not detected by any local anchor — stays in `ARCH/22` `RR-02`/`RR-03`. Implementation tracked as `AX-117`; device-key rotation/escrow remains open (`ARCH/14` Open question 1).
- **Protocol naming (resolved):** `DEC-023` fixes the canonical, frozen ACP permission method token as `session/request_permission`; no alias is accepted and `request/permission` is not a transition form. `ARCH/15` and `REQ-PROTO-002` are aligned; `ACC-P1-03`/`ACC-P1-05` were already specified against it.
- **Flagged for the owning lane:** `DEC-021` closes the `SRC-009` data-license hard gate and sets the catalog posture (curated primary + opt-in enrichment, no full-dataset snapshot by default). The hard-gate bullet above and `AX-107`'s "offline snapshot" wording predate that decision and need reconciling; `ARCH/22` `X-09`/`RR-06` and `REQ-SEC-017` are already aligned to `DEC-021`.
