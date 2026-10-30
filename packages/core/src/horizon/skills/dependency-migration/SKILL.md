---
name: dependency-migration
description: Use when migrating a dependency or API across versions: read changelogs and migration guides, inventory usages, batch mechanical updates, and verify build and tests per batch.
---

# Dependency Migration (builtin.dependency-migration)

Migrate a dependency or an API surface across versions with version-aware evidence:
read the changelog and migration guide, inventory every usage, update in mechanical
batches, and verify build plus tests after each batch. The lockfile changes only
through the package manager, and every mutation crosses the Guard admission.

## When to use

- A dependency must move to a new major or minor version.
- A framework or library API changed and call sites need updating.
- Security or support policy requires an upgrade with breaking changes.
- A transitive version conflict forces a coordinated bump across packages.

## Workflow

1. Pin the present: read the lockfile and manifest for the exact current version,
   and record why the migration is needed (policy, CVE, feature, conflict).
2. Choose the target version and read its changelog and migration guide; use web
   search only when the local repo lacks the release notes. Quote the breaking
   changes that actually touch this codebase.
3. Inventory usages: grep every import, call site, config key, and type reference
   to the dependency. Produce counts per file, including tests and scripts.
4. Classify each usage: unaffected, mechanical update (renamed import, moved path),
   breaking (signature or semantics changed), or UNKNOWN. UNKNOWN items get read
   against the new version source or docs before any edit.
5. Plan batches: mechanical changes first, breaking changes one module at a time,
   config and lockfile updates last. Each batch must leave the tree green.
6. Per batch: apply edits, run the package manager install, then build and the
   focused tests for the touched area. Stop the batch on red and fix before moving on.
7. Update peer ranges, engine constraints, and CI version matrices in the same
   batch as the code that depends on them; never leave manifest and lockfile inconsistent.
8. After the final batch: run the repo-wide build, full test suite, and lint or
   typecheck. Compare results to the pre-migration baseline recorded in step 1.
9. Report the migration map: versions, per-batch diffs, verification outputs, and
   any usage left un-migrated with its reason.

## Output contract

- Version map: current, target, and the reason for the migration.
- Breaking changes: the list that applies to this codebase, each with a source link.
- Usage inventory: per-file classification counts, with UNKNOWN items named.
- Batches: what changed, commands run, and results per batch.
- Final verification: build, test, and lint outputs versus the baseline.
- Leftovers: any usage or config not migrated, with the exact blocker.

## Honesty rules

- Never edit a lockfile by hand; regenerate it with the package manager only.
- Do not claim migration success without build and test output from real runs.
- Changelog claims are leads, not proof — verify against the installed version.
- Label behaviors of the new API UNKNOWN until confirmed by docs, types, or a run.
- Report PARTIAL when a batch is blocked and leave the tree green where possible.