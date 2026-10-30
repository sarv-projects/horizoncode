---
name: release-readiness
description: Use when a release candidate must be assessed: run build, tests, license, config, and packaging gates, check version bumps and changelog, and report GO or NO-GO with evidence.
---

# Release Readiness (builtin.release-readiness)

Assess a release candidate against a fixed gate list and return GO or NO-GO backed
by executed commands. Gates cover the clean tree, version and changelog, build,
full tests, lint and typecheck, licenses, config, and packaging. Any gate that did
not run is a NO-GO input, never an assumed pass.

## When to use

- A release, publish, or tag is about to happen and needs a check.
- A version bump and changelog entry must be validated.
- A managed run finished implementation and needs a release verdict.
- A periodic readiness check on the current branch is requested.

## Workflow

1. Read the repo release process: the rules file, release docs, and CI pipeline
   commands. The gate list comes from the repo, not from habit.
2. Verify tree state: `git status` clean, on the expected branch and commit, with
   no untracked artifacts that would ship. Confirm the version bump location and
   that the version is not already published.
3. Check the changelog entry: present, dated, accurate against the actual diff, and
   free of unreleased placeholders or broken links.
4. Run the build command from the repo map; capture exit code and artifact output.
5. Run the full test suite; capture pass and fail counts. Any failure forces
   NO-GO regardless of how many other gates are green.
6. Run lint and typecheck (or the repo equivalents); capture results.
7. Check licenses: project license present, third-party notices current, and no
   copyleft dependency added without a recorded decision.
8. Check packaging: perform a pack or dry-run build, inspect the artifact manifest
   for unintended files, and confirm the build embeds no local paths or secrets.
9. Reproducibility spot check: rebuild and compare artifact hashes or file lists;
   note any nondeterminism found.
10. Compile the gate table and issue the verdict with the exact failing gate
    named for any NO-GO.

## Output contract

- Gate table: gate, exact command, result (PASS, FAIL, or SKIPPED), evidence line.
- Version and changelog status with file references.
- Blockers: each item forcing NO-GO, with the command output that proves it.
- Verdict: GO or NO-GO, plus the conditions that would flip it.
- Follow-ups: non-blocking items to fix before the next candidate.

## Honesty rules

- The verdict comes only from commands executed this session, with output quoted.
- A skipped or unrun gate is a NO-GO input; never mark it PASS by assumption.
- Never bump versions, tag, or publish in this skill; assessment only.
- Mark unknowns UNKNOWN and list them as follow-ups, not as passes.
- Report PARTIAL when an environment limit (no network, no registry) blocked a gate.