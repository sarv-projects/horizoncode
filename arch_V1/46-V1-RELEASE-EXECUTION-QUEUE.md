# V1 release execution queue — ordered work + subagent dispatch

**Status:** 2026-10-26. **Authority:** implementation order and parent orchestration; does not replace normative HLD/LLD (topic owners in `arch_V1/README.md`). **Sync with:** [`46-V1-WIRE-TRACKER.md`](46-V1-WIRE-TRACKER.md) (wire status), [`46-V1-SOURCE-ALIGNMENT-AUDIT.md`](46-V1-SOURCE-ALIGNMENT-AUDIT.md) (code paths), [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md) (P0–P9 rows).

**Evidence rule:** `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED`. Items below stay open until cited tests/commands pass on a recorded revision.

---

## Wave 0 — Parent / shared gates (no feature flags)

| # | Item | Owner | Exit evidence |
|---|------|--------|----------------|
| 1 | `PYTHONPATH=.` or repo-root `sys.path` for `scripts/release/test_release_readiness.py` | Parent | `python3 scripts/release/test_release_readiness.py` **OK** |
| 2 | `horizoncode:typecheck` fails on any `error TS` | Parent | `scripts/architecture/horizoncode_typecheck.sh` exit **0** |
| 3 | Clear TS diagnostics (opencode, tui, core) | Parent | same |
| 4 | `bun turbo typecheck` whole workspace | Parent | **0** diagnostics |
| 5 | `audit_overlay_visibility.py` | Parent | **0** hidden changed / new / stale unignore |
| 6 | `validate_convergence.py` + `audit_markdown_repo.py` | Parent | **0** active blockers |
| 7 | Git hygiene: clean revision for release evidence | Parent / user | `release_gate` source **clean**; phase-owned commits |
| 8 | **DEC-V1-11** distribution license + NOTICE | User/legal | P9 audit unblocked |
| 9 | **DEC-V1-12** signing or LOCAL_ONLY_UNSIGNED | User | gate documents deferral |
| 10 | **DEC-V1-09** retention/legal-hold | User/legal | no false erasure claims |

---

## Waves 1–6 — Product (effect flags stay false until §32 proof)

| Wave | IDs | Theme | Subagent |
|------|-----|--------|----------|
| **1** | 11–20 | P1 Guard, terminal, sandbox, read fast path, C25 | **SA-P1** |
| **2** | 21–30 | P2 managed, HostRun chain, verifier, child turns | **SA-P2** |
| **3** | 31–36 | P3 RepoIntel, context, instructions | **SA-P3** |
| **4** | 37–44 | P4–P7 LSP/search/providers/TUI integration | **SA-P4–P7** |
| **5** | 45–47 | P8 RC0 attestation, baselines, quotas | **SA-P8** |
| **6** | 48–58 | P9 artifact, platform, final gates, registry wired | **SA-P9** + parent |

Full row text (11–58) matches the parent orchestration ledger in `reports/phases/LEDGER.md` and the 2026-10-26 user queue; **do not duplicate prose here** — use wire tracker row IDs (CP-01–06, W-P*-*) as the stable keys.

**P9 helper ceiling (explicit):**

- P1/P2 integrated security/performance + final CI are **outside** `release_gate.py` alone — parent runs `run_push_gate.sh` / `run_full_gate.sh` and cross-phase acceptance.
- Linux/WSL **platform acceptance** ≠ install-matrix only; matrix row must be **NOT_VERIFIED** until full §18 platform table passes.

---

## Subagent dispatch (parent turn 1)

Launch **≥6** `Task` subagents (`model: inherit` if fast models fail). Parent allowlist: `AGENTS.md`, `LEDGER`, shared `scripts/architecture/*` — see root `AGENTS.md` §Anti-sequential-slippage.

| Agent | Phase | Write scope (exclusive) | Queue IDs |
|-------|-------|-------------------------|-----------|
| SA-P1 | P1 | `kernel/src/{guard,effect_host,host_kernel,terminal,worker*}`, Core session Guard/read-batch | 11–20 |
| SA-P2 | P2 | `kernel/src/managed_*`, `worker_durable.rs`, `packages/opencode/src/session/managed-*` | 21–30 |
| SA-P3 | P3 | Core `context*`, `project-instruction*`, `repo-*`, `indexd/` | 31–36 |
| SA-P4 | P4 | `packages/opencode/src/{lsp,dap,repl}/` | 37–38 |
| SA-P5 | P5 | `code-mode*`, `websearch*`, websearch runtime | 39–40 |
| SA-P6 | P6 | `auth/`, `provider/`, `question/`, `models-dev.ts` | 41–42 |
| SA-P7 | P7 | `packages/tui/**`, AppRuntime/stream/artifact routes | 43–44 |
| SA-P8 | P8 | `scripts/perf/**`, kernel JC-RES tests | 45–47 |
| SA-P9 | P9 | `scripts/release/**`, `install`, packaging identity | 48–51 |
| SA-PARENT | — | architecture scripts, typecheck, overlay, integrate | 1–7, 53–55 |

**Cargo:** one heavyweight `cargo test` at a time (SA-P1 or SA-P2). **Second wave:** effect-flag flips (12, 24, 29, 30, 39) only after typecheck green — never parallel edits on `host_kernel.rs` + `managed-control.ts`.

---

## Design / schema / wiring gaps (implementer checklist)

Use this before opening new types — prefer extending existing contracts.

| Gap | Normative | Schema / seam | Code today | Wire / backlog |
|-----|-----------|---------------|------------|----------------|
| HostRun bind → P8 cursor proof | `12` §HostRun, `37` §37.19, `17` DEC HostRun | `host-run-dispatch-v1.schema.json` | `managed-control.ts` decoders; routes fail-closed | W-P2-*, 21–23 |
| P8 cursor verifies committed event | `12`, `32` HOST-RUN-003 | same | **Not proven** — shape-only today | P2/P8 |
| `CodeDisplayPipelineV1` name vs `code-display.ts` | `31` §31.23, `37` §37.12 | render DTOs | **PART** tests | W-P7-08 |
| `compileOverlapMs` / SPD-A | `30` §30.28 | context-compile-policy | **missing consumer** | P3-10, 34 |
| Read fast path E2E | `14` §14.3.1, DEC-V1-36 | `prepare_tool_batch_read` | kernel + `direct-read-batch.ts` | W-P1-07, 19 |
| Session owner + SSE question filter | `37` §37.11 | — | `owner.ts`, `packages/server/.../event.ts` | **Partial** — QA-007 HTTP half has a focused route test (`reports/phases/P6.md:3420-3439`); the SSE filter remains RED/not verified and the actual `/api/event` owner boundary is outside P7's grant (`reports/phases/P7.md:912-913,931-940`); doc in §37 |
| Registry `wired` | `33`, `contracts-v2/capability-registry-v1.json` | 230 IDs | **0 wired**, 4 `code_present` | 56 |
| Effect gates (search, CodeMode, child turns) | `33`, product config | feature-exposure | constants **false** | 29–30, 39–40 |
| Trusted RC0 | `18` §18.17, RC0 plan | `AttestationV1` | `TRUSTED_ATTESTATION_SOURCES=()` | 45–46 |
| Platform WSL/Linux | `18` §18.13 | release matrix JSON | **NOT_VERIFIED** | 52, 55 |

**Plan supplement:** [`docs/superpowers/plans/2026-10-25-hostrun-contract.md`](../docs/superpowers/plans/2026-10-25-hostrun-contract.md) — HostRun chain prose; must stay aligned with `12-DOMAIN-SCHEMAS.md` and `managed-control.ts`.

---

## Minimal critical chain (7 steps)

1. Parent **1–7** (this wave; typecheck + overlay + validators).
2. **SA-P1 + SA-P2:** 11–13, 21–23.
3. Parent: HostRun integration smoke.
4. **SA-P6 + SA-P7:** 41, 44.
5. **SA-P5:** 39–40.
6. **SA-P8:** 45–46 (after 23).
7. **SA-P9:** 48–55 + platform row **52**.

---

## Maintenance

When code or status changes: update **§5** of [`46-V1-SOURCE-ALIGNMENT-AUDIT.md`](46-V1-SOURCE-ALIGNMENT-AUDIT.md), relevant **W-P*** rows in the wire tracker, and this file’s **Wave 0** exit column only — do not mark waves 1–6 complete without §32 evidence.
