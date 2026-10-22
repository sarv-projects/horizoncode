# Repository root file inventory

**Last reviewed:** 2026-10-22

## Authoritative at root

| Path | Role |
|---|---|
| `README.md` | Product README (English only at root) |
| `AGENTS.md` | Coding-agent and orchestration policy |
| `HANDOFF.md` | **Implementation status authority** (~800 KB; grows over time) |
| `implementationtov1release.md` | V1 phase tracker and scope ledger (~719 KB) |
| `CURRENT_RUN.md` | Append-only work diary — **not** status authority (~1.1 MB) |
| `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` | Project metadata |
| `arch_V1/`, `packages/`, `kernel/`, `docs/`, … | Source and architecture |

## Removed from root (2026-10-22 purge)

Purged as redundant with `AGENTS.md`, `arch_V1/`, or git history:

- `CURRENT_RUN.previous-full-2026-10-12.md`
- `README.{locale}.md` (20 i18n copies; English `README.md` only)
- `HANDOFF_PROMPT.md`, `IMPLEMENTER_PROMPT.md`
- `CONTEXT.md`, `STATS.md`

## V1 navigation

1. [arch_V1/46-V1-WIRE-TRACKER.md](../arch_V1/46-V1-WIRE-TRACKER.md) — wire / done-not-done  
2. [arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md](../arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md)  
3. [arch_V1/46-V1-FEATURE-INVENTORY.md](../arch_V1/46-V1-FEATURE-INVENTORY.md)  

## Optional hygiene (local only)

| Path | Note |
|---|---|
| `.horizon_arch_review.txt` | Gitignored review dump — safe to delete locally |
| `.horizoncode-e2e-20261013/` | Dated scratch — remove when unused |

Large diaries (`CURRENT_RUN.md`, `HANDOFF.md`) may be rotated into `docs/archive/` in a future cleanup; do not treat rotation as changing status authority.
