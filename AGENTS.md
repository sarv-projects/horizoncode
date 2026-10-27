# AGENTS.md — HorizonCode implementation rules

## 0. Standing order (controlling)

**Today's directive: finish fast. Implement as much as possible. Verify at the end.**
No quota ceiling. No per-slice gate. No idle orchestration. The unit of work is *the whole request*, and the only stopping condition is the request being done or a real blocker.

If any line below is ambiguous, resolve it in favor of *more parallelism, more implementation, less ceremony*.

## 1. Platform capability

- 8 concurrent Task subagents per level. Nesting supported (≥1 level deep, more if the tool allows).
- Subagents returning is normal — it's a handoff, not a stop. Integrate or re-dispatch immediately.
- Never serialize for caution. Never wait for "all children." Never idle while slots are free.

## 2. Fan-out rules

- **Parent:** 8 phase leads in flight, immediately, in the first actionable turn.
- **Phase lead:** 4–8 package workers.
- **Package worker:** 0–4 nested workers for independent sub-tasks.
- Fill every slot. Refill every freed slot within the same turn.
- Phase leads own acceptance; package workers own bounded code. Units are small and many.

## 3. Implementation-first doctrine

1. **Code, not plans.** Deliverable is working code + tests. No plan essays, no audits before dispatch.
2. **Batch aggressively.** One subagent = one bounded package, done fast, returned fast. Parent integrates.
3. **No per-slice gate.** Do not stop at first green test, first commit, first module. Keep going.
4. **Blocked part? Keep going.** Report the exact blocker to the parent, work the unblocked parts in parallel, resume when prerequisite lands.
5. **Parent implements too.** If all 8 slots are busy, parent writes shared unblockers or an owned package. Idle parent is a violation.
6. **Builds:** no two *identical* heavyweight builds at once. Distinct builds parallelize freely — RAM/disk is the only limit.
7. **Verification is batched at the end.** Per-package: compile + focused tests only. Full acceptance, Guard negatives, recovery, cross-phase, CI, release gates run once at the end of the request.

## 4. Bootstrap (cheap)

- **Session start:** this file, `HANDOFF.md` digest block, `arch_V1/README.md`, `arch_V1/17`, operative plan (skim). Engram `mem_context`, one targeted `mem_search`.
- **After compaction:** the `HANDOFF.md` digest block only (≤15 lines: active phase, owner, rev, blockers, dispatch queue). Re-dispatch ACTIVE owners before any product edit.
- Do not re-read the whole doc set mid-session. Open an arch doc only for the file you're about to touch.
## 5. Skill routing (when to use which)

Read the matched `skill://` skill once per session before using it. Skills that
gate work without adding speed are opt-in, not default. If a skill and §0 conflict,
§0 wins.

| Skill | Trigger | Doctrine note |
|---|---|---|
| `using-superpowers` | Session start, before any other skill | Once per session, not per turn |
| `dispatching-parallel-agents` | 2+ independent packages/leads exist | **Mandatory** companion to §2 fan-out |
| `subagent-driven-development` | Executing a multi-package plan with independent tasks | **Mandatory** when nesting §2 |
| `test-driven-development` / `tdd` | Any feature or bugfix package | Per package; not per phase |
| `systematic-debugging` / `diagnosing-bugs` | Failing test, unexpected behavior, perf regression | **Before** proposing any fix |
| `verification-before-completion` | **Only at final verification (§9)** | Once, at the end — not per package |
| `requesting-code-review` / `code-review` | Before merging phase output / at §9 | Final gate, not mid-flight |
| `using-git-worktrees` | Isolation is genuinely needed (heavy build collision, risky refactor) | Bounded pool; not per subagent |
| `finishing-a-development-branch` | Phase output ready to integrate | At integration boundary |
| `writing-plans` / `executing-plans` | User explicitly asked for a plan, or plan already approved | Do **not** write plans otherwise (§3.1) |
| `codebase-design` / `codebase-intelligence` / `improve-codebase-architecture` | Designing interfaces, tracing blast radius before a large refactor | Use before large-scope edits, not for routine ones |
| `domain-modeling` | GLOSSARY.md / ADR work | Doc-only scope |
| `brainstorming` | Genuinely novel design with no existing local reference | **Opt-in only** — banned when a local/pinned reference exists |
| `opencode` | Any OpenCode-internal question or change | Route to it before guessing package layout |
| `effect` | Effect v4 / effect-smol TypeScript | Applies inside `packages/**` where relevant |
| `horizon-docs` | arch_V1/ or status doc edits | Doc-only |
| `frontend-design` / `ui-ux-pro-max` / `ui-styling` / `high-end-visual-design` / `rtl-aware-development` | UI work in P7/P4 surfaces | P7/TUI and app surfaces only |
| `webapp-testing` / `browser-use` / `agent-browser` | Browser/E2E verification at §9 | Pair with Playwright if a harness exists |
| `mcp-builder` / `mcp-integration` | MCP server build or integration | P5 territory |
| `plugin-structure` / `command-development` / `hook-development` / `agent-development` / `skill-development` | Claude/OpenCode plugin components | Same files, same Guard |
| `skill-creator` / `writing-skills` / `writing-for-agents` / `writing-hookify-rules` | Creating/editing skills or AGENTS.md | Only when editing those artifacts |
| `doc-coauthoring` / `document-creation` / `pdf` / `docx` / `xlsx` / `pptx` / `slides` | Producing docs/artifacts | Not for architecture authority files |

**Anti-ceremony rules:**
- No skill may be used as a reason to stop, write a report, or add a gate that §0 doesn't already require.
- `brainstorming`, `writing-plans`, `verification-planning`, and `requesting-code-review` are **not** per-package defaults. They run once at the boundary they name.
- If a skill's workflow says "stop and confirm," continue unless it's a real blocker (§3.4).


## 6. Parent duties (tight loop)

1. Build the phase DAG, assign one lead per runnable phase with exclusive scope.
2. Dispatch all runnable phases in one turn. Refill every freed slot.
3. Integrate returns immediately; re-dispatch failures (`PARTIAL_INTERRUPTED` → retry with `model: inherit` or another slug).
4. Arbitrate shared files, keep one canonical contract.
5. When slots are full: implement a shared unblocker or an owned package.
6. **At the end of the request:** run real journeys, Guard negatives, cancel/restart/UNKNOWN recovery, cross-phase tests, build, CI, release gates. Report VERIFIED or PARTIAL with exact evidence.
7. Update the ledger + `HANDOFF.md` digest at every stop.

## 7. Subagent return format (short)

- **`DONE`**: files changed, tests run + result, blockers.
- **`PARTIAL`**: what's done, what's blocked, exact prerequisite needed.

No prose. No evidence essays mid-flight. The full evidence bar is a final-verification task, not a per-subagent tax.

## 8. Ledger

One compact file, `reports/phases/LEDGER.md`:

| Phase | Lead | Workers | Scope / rev | Blocked on | State | Next dispatch |
|---|---|---|---|---|---|---|

States: `QUEUED`, `ACTIVE`, `BLOCKED`, `INTEGRATING`, `VERIFIED`, `PARTIAL_INTERRUPTED`. Keep it live; it's the resume manifest.

## 9. Final verification (once, at the end)

Run together, not per-phase:
- Full build + full typecheck
- Cross-phase integration tests
- Guard no-bypass / permission negatives
- Cancel / crash / UNKNOWN recovery
- Real product journey (not mocks),complete e2e testing,all features
- CI, packaging, release gates if in scope
- Worktree/process/disk sanity

Report: changed files, capability IDs, exact commands + results, negatives, platform, remaining gaps, cleanup status. Anything unverified is marked NOT VERIFIED, never assumed.

## 10. Immutable (do not trade away for speed)

- Rust owns Goal/SpecVersion/Run/Task/Attempt, ToolBatch control, effects/leases/receipts, Evidence/Verification, durable automation.
- Every mutation crosses the same Guard/ExecutionHost. No bypass from plugin/MCP/LSP/DAP/browser/desktop/REPL/automation origins.
- One canonical capability registry. No duplicate runtimes. No parallel authoritative Core.
- Model self-report is not completion evidence.
- No unapproved paid calls, credential export, or remote mutation.
- Preserve user-owned files and processes; stay inside the repo filesystem boundary.
- No disabled tests, no false success.

## 11. Scope exceptions

- Single named file/doc, no product code → parent edits directly, no wave.
- Pure research/audit, no code change → read-only tools, optional explore agents.

Everything else: fan out, implement, verify at the end.

## 12. Continue, don't stop

A commit, a green test, a returned subagent, a completed phase — none of these end the request. Keep dispatching, keep integrating, keep implementing until the full request is done or a real blocker stops progress. If interrupted, write the ledger and digest so the next turn resumes instantly.


## Inherited OpenCode package instructions and precedence

The pinned upstream snapshot at `opencode/` ships its own instruction files —
`opencode/AGENTS.md`, `opencode/packages/app/AGENTS.md` and
`opencode/packages/effect-drizzle-sqlite/AGENTS.md` — which may be hydrated next
to these rules. They are reference material only: never rewrite the pinned upstream instruction snapshot, and never let it override this file. Where an
upstream instruction conflicts with Horizon rules, these rules win — above all
the Rust Guard admission requirement for every mutation, the branch/commit policy
and the process rules in §0.

Authority pointers: decisions live in `arch_V1/17-GOVERNANCE-DECISIONS.md`, the
current operative plan is `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md`
(hostrun contract detail: `docs/superpowers/plans/2026-10-25-hostrun-contract.md`),
and external source provenance is `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md`.
