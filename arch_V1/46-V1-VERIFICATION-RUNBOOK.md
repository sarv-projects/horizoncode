# V1 verification runbook — run when implementation claims “done”

**Purpose:** executable checklist after code fill. **Does not replace** `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` — maps catalog IDs to commands and edge emphasis.

**Rule:** VERIFIED only on **exact git revision** with cited command output. Model self-report is not evidence.

---

## Phase 0 — Structural gates (always first)

```bash
cd /path/to/agentx
python3 scripts/architecture/validate_convergence.py   # expect FAILURES 0
python3 scripts/architecture/audit_markdown_repo.py      # expect ACTIVE_BLOCKERS 0
```

Optional exhaustive markdown hash: `audit_markdown_repo.py --json-report docs/audit-markdown-latest.json`

---

## Phase 1 — Unit / package tests (incremental during dev)

| Area | Command (repo root) | Catalog |
|---|---|---|
| Schema | `cd packages/schema && bun test` | context-selection, context-compile-policy fixtures |
| Core session/context | `cd packages/core && bun test test/session/` | CTX-*, CX-* helpers |
| OpenCode session/tools | `cd packages/opencode && bun test test/session/ test/tool/` | TB-*, tool registry |
| TUI components | `cd packages/tui && bun test` | ACT-*, UI-* where fixtures exist |
| Kernel | `cd kernel && cargo test` | Guard, effect_host, worktree tests |

Throttle: **one** heavy `cargo build` at a time on WSL.

---

## Phase 2 — Security / Guard negatives (P1)

Run families from **§32.14** (ToolBatch), **§32.20** (effects), **§32.43** (GRANT):

- Denied capability before lease
- Lease reuse / widen attempt
- Cancel mid-effect → UNKNOWN → no blind retry
- Plugin/MCP path cannot bypass Guard
- Command profile: wrong digest / out-of-grant argv → deny

Document: test name + kernel/Core log excerpt.

**§32.49 `PERF-DIRECT-*`** (warm kernel, **Coding (recommended)** preset): provider-only
not blocked on kernel; read fast path before stream end; batched reads; migration matrix
[`46-V1-MIGRATION-PARITY.md`](46-V1-MIGRATION-PARITY.md).

**§32.50–52** (`SPD-*`, `EXP-*`, `ACC-*`, `REL-*`, `LH-*`) after P3/P6 exposure and P4 edit-loop wiring.

---

## Phase 3 — Context and cache (P3/P6/P7)

**§32.10 `CX-001`–`CX-025`**, **§32.13 `INST-001`–`INST-008`** emphasis:

| ID | Edge |
|---|---|
| CX-001 | Huge tool output → artifact + recoverable |
| CX-003 | Protected Goal line survives prune |
| CX-013 | Cache telemetry UNKNOWN when provider silent |
| CX-014–015 | Anchor digest stable 3 turns; **do not fail on cache_read==0** |
| CX-016–017 | Groq/local minimize; gateway strips cache |
| CX-018 | Workspace revision bumps anchor epoch |
| CX-021 | Canary matrix Anthropic / OpenAI / Groq / gateway |
| CX-022–025 | Monorepo instruction walk; on-demand subdir; skill bodies lazy; external import gate (§29.23) |

**§32.45 `CTX-001`–`CTX-005`:** ledger digest binds selection; no raw prompt in event.

**§30.26.10:** empirical cache law — record observed `cache_read` or UNKNOWN.

---

## Phase 4 — RepoIntel (P3)

**§32.4 `RD-*`**, **§32.23**, V1-ADAPT-004:

- Stale generation → typed STALE, no write
- Read-scope mismatch
- Bounded pages / cursor continuation
- `repo.tree` output cap 32 KiB
- Symlink / revision journeys when enabled

---

## Phase 5 — Managed lane (P2)

**§32.9**, **§32.12 `SA-*`, `LANE-*`, `MPT-001`:**

- No managed dispatch without live Attempt
- Direct lane never gains managed receipts
- LANE-004 multi-hop direct turn without per-hop HostKernel context bind
- Child result after parent compact still retrievable (SA-009)

---

## Phase 6 — Providers / Doctor (P6)

**§32.21**, **§32.31 `PD-*`, `FEAT-001`–`014`:**

- No hidden model/provider switch on 429
- Doctor full tier requires consent
- Offline catalog freshness UNKNOWN handling
- LM-018 free-model journey (if in scope) with route evidence

---

## Phase 7 — TUI / UX (P7)

**§32.16 `UI-*`**, **§32.48 `ACT-*`:**

- Scroll anchor during stream (UI-002)
- 10k message load (UI-006)
- Fast code/diff display + highlight RAM caps (UI-024–030, §31.23)
- Activity cards + Ctrl+R review (ACT-004–005)
- Keyboard-only approval (UI-014)
- Export 1 MiB cap (UI-018)

Manual: 80×24 terminal layout §16.21.4.

---

## Phase 8 — Resources / worktrees (P8)

**§32.32–33 `JC-RES-*`, `GS-*`:**

- Reservation state machine §18.18
- Impersonation negatives JC-RES-012
- Worktree lease conflict

---

## Phase 9 — Recovery / healing

**§32.19 `RC-*`:** syntax patch, loop detection, crash after effect, disk pressure cleanup scope.

---

## Phase 10 — End-to-end journeys (final)

From **§32** intro + **§10.18**:

1. **Direct coding journey:** new session → provider pinned → edit file via tool → test → no Guard bypass.
2. **Managed journey:** goal propose → accept → single Task → verifier PASS (then multi-Task when P2+P8 ready).
3. **Context pressure:** force large tool log → trim → compact → continue same model.
4. **Reconnect:** kill CLI mid-stream → restart → no duplicate messages (UI-017).
5. **HUP-001–006** harness comparison (if claiming competitive SWE) — matched arms only (`DEC-V1-34`).

---

## Phase 11 — Release gates (P9)

- `implementationtov1release.md` checklist
- `18-OPERATIONS-RELEASE.md` install/upgrade
- CI workflow `horizoncode-release-qualification.yml` when enabled
- Clean install on fresh WSL per plan §10.11

---

## Failure triage

| Symptom | First owner doc |
|---|---|
| Effect without receipt | `14`, `11` |
| Wrong context / cache claim | `30` §30.11, §30.26 |
| Tool not in registry | `33`, `29` |
| UI stream duplicate | `31`, `37.11` |
| Provider drift | `17` §17.26, `DEC-V1-32` |

Log failures in `HANDOFF.md` with revision + test ID; do not mark VERIFIED until row green.
