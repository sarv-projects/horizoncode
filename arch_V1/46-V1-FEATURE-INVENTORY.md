# V1 feature and surface inventory (normative catalog)

**Authority:** `arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md` (tools/capabilities), `29-AGENTS-SKILLS-HOOKS-MCP.md` (agents), `16-UX-SETTINGS-ECOSYSTEM.md` (UX/slash law), `10-DELIVERY.md` §10.18 (release scope).

**Machine list:** all **230** capability IDs in [`generated-capability-ids.txt`](generated-capability-ids.txt) (`contracts-v2/capability-registry-v1.json`). Registry status 2026-10-22: **226 `designed`**, **4 `code_present`** (`builtin.horizon-docs`, `files.write`, `providers.infer`, `question.ask`).

---

## V1 surfaces (in scope)

| Surface | Normative | Post-V1 |
|---|---|---|
| CLI `horizoncode` / `hzcode` | `18`, `10` | — |
| TUI single-pane + overlays | `16` §16.21, DEC-V1-33 | Web/desktop GUI |
| Managed Goal/Run (CLI/TUI) | `11`, `16` §16.9 | — |
| SDK/HTTP instance API | `37.19` (CLI/TUI-first V1) | Remote clients |

---

## Built-in agent profiles (`33` §33.2–33.3)

| Profile ID | Role |
|---|---|
| `builtin.build` | Primary implementation / debugging |
| `builtin.plan` | Read-first planning |
| `builtin.explorer` | Fast file/symbol locate (subagent) |
| `builtin.architect` | Cross-package design (subagent) |
| `builtin.librarian` | Docs/web research (subagent) |
| `builtin.looker` | Vision / UI assets (subagent) |
| `builtin.reviewer` | Review pass (subagent) |
| `builtin.test-debugger` | Test failure diagnosis (subagent) |
| `builtin.system-operator` | Bounded system ops (subagent) |
| `builtin.browser-qa` | **post-V1** browser QA (subagent) |
| `builtin.history-search` | History retrieval specialist |
| `builtin.verifier` | Verification evidence producer |

Schema: `arch_V1/contracts-v2/agent-profile-v2.schema.json`. Runtime: Core Config + `kernel/src/agent_profile.rs`.

---

## Harness profiles (`33` §33.20)

| Harness | Use |
|---|---|
| `harness.native-rich` | Default rich tool surface + lazy discovery |
| `harness.native-minimal` | Small-context models |
| `harness.bash-only` | Shell-loop models |

Schema: `harness-profile-v1.schema.json`.

---

## Built-in skills (`33` §33.17)

| Skill ID | Purpose |
|---|---|
| `builtin.horizoncode` | **Product integration** — tools, skills, tiers, lanes (always catalog-listed) |
| `builtin.horizon-docs` | Architecture/docs retrieval |
| `builtin.repo-onboarding` | Repo stack / commands / entrypoints |
| `builtin.plan-change` | Scoped implementation plan |
| `builtin.review-change` | Code review |
| `builtin.test-debug` | Test debugging |
| `builtin.refactor-safely` | Behavior-preserving refactor |
| `builtin.dependency-migration` | Dependency upgrades |
| `builtin.browser-smoke-test` | **post-V1** |
| `builtin.performance-profile` | Profiling / benchmarks |
| `builtin.security-review` | Defensive security review |
| `builtin.release-readiness` | Release checklist |
| `builtin.commit-pr` | Commit/PR summary |
| `builtin.context-recovery` | Trim/prune/compact guidance |
| `builtin.plugin-audit` | Extension audit |
| `builtin.worktree-hygiene` | Worktree cleanup proposals |

Manifest: `skill-manifest-v2.schema.json`; loading law `29` §29.7.

---

## Built-in maintenance jobs (`33` §33.4)

`job.title.generate`, `job.commit_message.generate`, `job.pr_summary.generate`, `job.query.rewrite`, `job.context.trim`, `job.context.prune_propose`, `job.context.summarize`, `job.artifact.retention_classify`, `job.progress.recap`, `job.repo.detect`.

---

## Model tool families (V1 catalog — exposure varies)

Normative IDs in `33` §33.5–33.16. Summary:

| Family | Example capability IDs | V1 notes |
|---|---|---|
| Repo / files | `files.*`, `repo.*`, `text.*`, `glob.*`, `symbols.*` | `read`→`files.read`, `write`→`files.write`, `apply_patch`/`edit`→`files.patch` (§33.5); `repo.tree`/`repo.detect` gated until P3 acceptance |
| Git | `git.status` … `git.worktree.*` | Read subset via `GitWorkspaceReadServiceV1` §37.29 |
| Terminal | `terminal.run`, `terminal.start`, … | Profile + shell modes §37.27 |
| Build/test | `build.*`, `test.*`, `lint.*`, `format.*`, `benchmark.*` | Wrapped terminal effects |
| Web search | `web.search`, `web.search.providers` | V1 `DEC-V1-26` |
| Context/history | `context.*`, `history.*`, `artifacts.*` | No canonical delete via context tools |
| Goal/run | `goal.*`, `run.*`, `task.*` | Managed lane |
| Agents | `agents.*`, `task` (child session) | Delegation §29 |
| Skills/docs | `skill.*`, `docs.*` | Progressive load |
| MCP | `mcp.*` | Plugin boundary §29.8 |
| Permissions | `permission.*`, `question.ask` | `question.ask` registry code_present |
| Automation | `automation.*` | §37.10 |
| Browser/desktop | `browser.*`, `desktop.*`, `preview.*` | **post-V1** A-V2-31 |
| Debug/REPL | `debug.*`, `repl.*` | V1 brokers when P4 passes |

**User-only (not model tools):** `editor.launch` via `/editor` — `16` §16.20, `37.28`.

---

## Slash commands and ActionDescriptors

**Law:** one ActionDescriptor ID per action (`16` §16.3). Slash is an alias, not authority.

### Canonical slash map

**Full table:** `16` §16.4.1 (normative). Heritage OpenCode slashes remain valid; context
aliases: `/summarize` → `/compact` (§30.3).

### Implemented in TUI today (`packages/tui` — verify against §16.4.1)

| Slash | session command value |
|---|---|
| `/settings` | `session.settings` |
| `/permissions` | `session.permissions` |
| `/goal-start` | `session.goal.start` |
| `/goal-propose` | `session.goal.propose` |
| `/goal-review` | `session.goal.review` |
| `/checkpoints` | `session.checkpoints` |
| `/agents` | `session.agents` |
| `/share`, `/unshare` | `session.share` / `session.unshare` |
| `/rename` | `session.rename` |
| `/timeline` | `session.timeline` |
| `/fork` | `session.fork` |
| `/compact`, `/summarize` | `session.compact` |
| `/undo`, `/redo` | `session.undo` / `session.redo` |
| `/timestamps` | `session.toggle.timestamps` |
| `/thinking` | `session.toggle.thinking` |
| `/copy`, `/export` | `session.copy` / `session.export` |
| `/editor`, `/editor --side`, `/editor --close` | prompt `promptCommands` |

**Gaps (migration):** `/trim`, `/prune`, `/clear`, `/view activity`, normative help labels for `/goal-*` as Advanced — P3-06, P7-03, P7-09. **Parity law:** `DEC-V1-36`, [`46-V1-MIGRATION-PARITY.md`](46-V1-MIGRATION-PARITY.md).

---

## Optional / experimental features (`16` §16.15)

Tracked via `FeatureExposureV1` + Settings; default OFF unless noted. Includes RepoIntel `lightweight|adaptive|full` (effective often `lightweight` until P4), compaction `auto`/`prune`, experimental flags in config descriptors.

---

## Post-V1 exclusions (do not implement as V1 requirements)

From `10` §10.7, §10.12, A-V2-31, §30.25, §42.21:

- Full browser automation surface, desktop control, web app shell
- Default cloud semantic index / mgrep / CRG as required paths
- Wasm plugin VM as authority
- Native Windows primary target
- VS Code / JetBrains / ACP editor integration (external editor CLI only in V1)

---

## Built-in hooks (`33` §33.18)

Lifecycle hooks per `hook-binding-v2.schema.json` — see catalog table in `33` for handler IDs (session start, tool pre/post, etc.).

---

## When adding a feature

1. Register capability in `capability-registry-v1.json` + `33`.
2. Add schema in `contracts-v2/` if wire-bound.
3. Add §32 acceptance rows.
4. Update this inventory and `46-V1-IMPLEMENTATION-BACKLOG.md`.
