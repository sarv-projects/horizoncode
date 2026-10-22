---
name: horizoncode
description: Deep integration map for HorizonCode — built-in tools, skills, capability tiers, Guard lanes, and how to use the product without loading the full arch corpus.
---

# HorizonCode integration (`builtin.horizoncode`)

Use this skill when the user or task needs **what HorizonCode provides**: tools, skills,
agents, slash commands, direct vs managed lanes, and honest feature status. Pair with
`builtin.horizon-docs` for normative architecture retrieval.

## When to invoke

- Onboarding to HorizonCode from OpenCode, Cursor, Claude Code, or Codex.
- “What tools/skills can you use?” / “What is wired vs designed?”
- Planning work that must respect Guard, grants, and capability tiers.
- Long-horizon sessions (context ops, checkpoints, optional Goals).

## Progressive disclosure (same as OpenCode/Codex pattern)

1. **Catalog metadata** — always in system prompt: skill IDs + short descriptions; `tools.search` / `skills.search` for discovery.
2. **This skill body** — load via `skill` tool when integration depth is needed.
3. **`builtin.horizon-docs`** — load for a specific arch § or acceptance ID.
4. **Full SKILL.md bodies** — other built-ins only when task-matched.

Do not paste the entire capability registry into chat.

## Product lanes

| Lane | Use | Requires Goal? |
|---|---|---|
| **Direct Session** | Pair programming, hours-long chat | **No** (default) |
| **Managed Goal/Run** | Multi-task, verifier, DAG | Yes (opt-in Advanced) |

Default preset: **Coding (recommended)** — §16.19.1, `DEC-V1-36`.

## Tool exposure tiers (§33.32)

| Tier | What the model sees first | Examples |
|---|---|---|
| **Core** | Always discoverable via search + default Build profile | `files.read`, `files.patch`, `git.*` read, `terminal.run` (profile), `tools.search`, `skills.search`, `skill`, `task`, `context.*`, `web.search` (if enabled), `repo.detect` |
| **Extended** | After search or profile grants | `repo.tree`, `symbols.*`, LSP/diagnostics, `history.search`, CodeMode `codemode.execute` |
| **Experimental** | User opt-in in Settings | RepoIntel full, embeddings, post-V1 browser/desktop |

Status bar / context ledger shows **effective tool count** and disabled reasons (§16).

## Built-in skills (invoke with `skill` tool)

| ID | Purpose |
|---|---|
| `builtin.horizoncode` | This integration map |
| `builtin.horizon-docs` | Architecture/contracts/status by § owner |
| `builtin.repo-onboarding` | Repo stack and entrypoints |
| `builtin.plan-change` | Scoped plan + acceptance |
| `builtin.review-change` | Review pass |
| `builtin.test-debug` | Failing tests |
| `builtin.refactor-safely` | Behavior-preserving refactor |
| `builtin.context-recovery` | trim/prune/compact/clear guidance |
| `builtin.commit-pr` | Commit/PR summary |
| (+ others §33.17) | Load when task matches description |

## Built-in agents (profiles §33.2)

`builtin.build` (default), `plan`, `explorer`, `reviewer`, `test-debugger`, … — subagents via `task` with profile ceilings.

## Canonical capability authority

All tool IDs live in `arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md` and
`contracts-v2/capability-registry-v1.json`. Registry status ≠ runtime WIRED; check
`HANDOFF.md` and `generated-capability-ids.txt`.

## Guard and speed (migration)

- **Reads** may use read fast path while streaming (`DEC-V1-36`).
- **Mutations** always: batch → Guard → lease → receipt.
- **UNKNOWN** is explicit; never silent success.

## Slash commands (§16.4.1)

`/permissions`, `/settings`, `/editor`, `/compact` (alias `/summarize`), `/trim`, `/prune`, `/clear`, `/checkpoints`, `/view activity` — `/goal-*` is **Advanced / managed only**.

## Normative references

- Speed/long-horizon: §30.27–30.30, §31.24
- Accuracy: §10.19, §30.29
- Exposure: §33.23, `DEC-V1-38`
- Bundle preset: `DEC-V1-37` Horizon Coding Profile
