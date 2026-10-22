# V1 migration parity — OpenCode, Cursor, Claude Code, Codex

Status: normative **product** requirements (`DEC-V1-36`, `DEC-V1-34`). Acceptance: §32.49 `PERF-DIRECT-*`.

HorizonCode adds Rust Guard, receipts, and optional managed Goals. **Direct pair programming**
must feel familiar—not slower, not more ceremonial—than the four reference agents below.

---

## 1. Design fixes (2026-10-22) — what changed

| Migration risk (reviewer) | Architectural fix |
|---|---|
| Whole batch before any tool | **Read fast path** — reads while streaming; mutations after batch close (§14.3.1) |
| Per-tool kernel IPC | **Batched read RPC** (≤8 reads) + **warm pooled IPC** (§13.2) |
| Approval fatigue | Default **Coding (recommended)** preset (§16.19.1) |
| Goal confusion | `/goal-*` labeled **Advanced / managed**; not in onboarding (§16.4.1) |
| Slash drift | Canonical map §16.4.1; `/summarize` → `/compact` alias (§30.3) |
| No latency law | §31.24 budgets + §32.49 tests |
| Provider blocked on kernel | Provider path independent of kernel READY (§13.2) |

---

## 2. Feature comparison (direct session, V1 target)

Legend: **Parity** = same user expectation · **Stricter** = safer/slower by design · **Extra** = Horizon-only · **Defer** = post-V1

| User expectation | OpenCode | Cursor | Claude Code | Codex | Horizon V1 (normative) |
|---|---|---|---|---|---|
| Chat without Goal | Yes | Yes | Yes | Yes | **Parity** — default |
| Pick model/provider | Yes | Yes | Yes | Yes | **Parity** — pinned per turn |
| Read files while agent works | Yes | Yes | Yes | Yes | **Parity** — read fast path |
| Edit files in workspace | Yes | Yes | Yes | Yes | **Parity** — grant reduces prompts |
| Shell / test | Yes | Yes | Yes | Yes | **Parity** — workspace command profiles |
| Subagent / task tool | Yes | Yes | Yes | Yes | **Parity** — Core child sessions |
| Compact / summarize context | Yes | Yes | Yes | variants | **Parity** — `/compact` + `/summarize` alias |
| Permissions / sandbox modes | Yes | Yes | Yes | Yes | **Parity** — `/permissions` |
| MCP / plugins | Yes | Yes | Yes | Yes | **Parity** — Guarded |
| Multi-step verified automation | Limited | Limited | Limited | threads | **Extra** — managed Goal (opt-in) |
| Effect receipts / UNKNOWN | Rare | Rare | Rare | Some | **Stricter** — visible, recoverable |
| Kernel IPC on mutations | No | IDE-integrated | No | Yes (Rust) | **Stricter** — bounded overhead targets |

---

## 3. Turn latency comparison (design intent)

| Phase | Competitors (typical) | Horizon V1 |
|---|---|---|
| Context compile | In-process | Same + ledger (budgeted separately) |
| Provider stream | Network-bound | Same |
| Reads | Often immediate | **Fast path** — target ≤+10% vs OpenCode (§31.24) |
| Writes/shell | In-process or IDE | Guard + lease — target ≤40 ms overhead (warm) |
| Approvals | Product-specific | **Coding preset** minimizes repeats |

---

## 4. What we do **not** claim for V1

- Faster than competitors on every benchmark (DEC-V1-34 requires matched evidence).
- Feature parity with **IDE** Cursor (editor shell, tab UI) — CLI/TUI only.
- Parity with Codex **cloud** managed threads UI — different lane, optional Goals.
- Weaker security on mutations to win speed tests.

---

## 5. Implementation backlog hooks

| ID | Deliverable | Arch |
|---|---|---|
| P1-10 | Read fast path + `prepare_tool_batch_read` | §14.3.1, `37` Guard bridge |
| P1-11 | Warm kernel IPC pool | §13.2 |
| P6-06 | **Coding (recommended)** default preset | §16.19.1 |
| P3-06 | Normative context slashes + aliases | §16.4.1, §30.3 |
| P7-09 | `/debug effects` diagnostics | §31.24 |
| P6-07 | `builtin.horizoncode` + exposure tiers | §33.32, DEC-V1-38 |
| P3-10 | Speed compiler SP-A..D | §30.28 |

**Product bundle:** `DEC-V1-37` (§10.19, §33.33) — speed, accuracy, reliability, capabilities, long horizon.

**File tools (OpenCode names):** `read` / `write` / `apply_patch` / `edit` map to `files.read`, `files.write`, and `files.patch` — §33.5 table; no `compose` file tool (`codemode.execute` for orchestration).

Update [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md) when rows move to WIRED.

---

## 6. Sign-off

Migration parity is **design-complete** when §32.49 passes on a pinned revision alongside
`PERF-DIRECT-*` evidence. Until then, treat competitor comparisons as **targets**, not release claims.
