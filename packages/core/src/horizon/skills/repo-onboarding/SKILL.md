---
name: repo-onboarding
description: Use when starting work in an unfamiliar repository and the agent must map stack, build/test/lint commands, rules files, entrypoints, and git state before editing.
---

# Repo Onboarding (builtin.repo-onboarding)

Produce a concise onboarding map so any HorizonCode session — direct session or
managed run — can build, test, lint, and navigate the current repository without
rediscovering the basics. This skill is read-only reconnaissance: it produces a
map, not edits, and it hands that map to planning, review, or dispatch work.

## When to use

- First turn in a repository the agent has not mapped this session.
- Before dispatching parallel work that depends on stack or build commands.
- When the user asks to onboard, explore the repo, or name the build and test commands.
- After context compaction, to re-anchor on commands and entrypoints only.
- When a task references files the agent cannot locate without an entrypoint map.

## Workflow

1. Fix the root and state: run `bash -lc "pwd && git rev-parse --show-toplevel &&
   git status -sb"`. Record branch, dirty or untracked files, and ahead/behind counts.
2. Read governing rules first: glob for `AGENTS.md`, `README*`, `CONTRIBUTING*`, and
   instruction files at the root; the root rules file governs every later step.
3. Detect the stack from manifests: package.json, pyproject.toml, Cargo.toml,
   go.mod, pom.xml, build.gradle. Record language versions, workspace members, and
   the lockfile that pins the package manager (pnpm-lock.yaml, uv.lock, Cargo.lock).
4. Extract commands verbatim from manifests, scripts, and docs: build, dev, test,
   lint, format, typecheck. Mark which are per-package, repo-wide, or need services.
5. Read CI truth: glob `.github/workflows/*`, `ci/*`, and pipeline configs; note
   the exact commands CI runs — those are the release-gate commands, not guesses.
6. Map architecture entrypoints: bootstrap and main files, app or server wiring,
   package index exports, and any capability or plugin registries. Use grep for
   registry construction and export barrels rather than reading whole directories.
7. Note scale and layout: top-level packages, monorepo tooling (turbo, nx, lerna),
   generated versus hand-written trees, and large vendored or fixture directories
   that should be excluded from future searches.
8. Check cheap git context: last 10 commits (`git log --oneline -10`), current
   worktree cleanliness, and whether this is a direct session or a managed run.
9. Compose the onboarding map from the Output contract and keep it under one
   screen so it can be pasted into a plan or subagent prompt without trimming.

## Output contract

Return exactly these sections, each backed by a command output or a file read:

- Root and state: repo root, branch, dirty or untracked summary, lane and Goal status.
- Stack: languages, versions, package manager, workspace layout, lockfile.
- Commands: build, test, lint, typecheck, dev — each with the file it came from.
- Rules: governing instruction files and the two constraints that most bind edits.
- Entrypoints: 3-7 files or directories that anchor navigation.
- CI gates: the exact commands CI runs and where they are defined.
- Risks: anything blocking build or test (missing services, env vars, secrets).

## Honesty rules

- Verify commands by running cheap probes (version, list, help) when safe; never
  claim a command works only because a README mentions it.
- Run nothing destructive during onboarding: reads, status, and logs only.
- If a command, version, or entrypoint could not be confirmed, label it UNKNOWN.
- If rules files conflict, report the conflict and follow the root file meanwhile.
- Report any blocker (no lockfile, missing toolchain) as PARTIAL with the reason.