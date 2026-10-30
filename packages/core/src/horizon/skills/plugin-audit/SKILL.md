---
name: plugin-audit
description: Use before enabling an extension or plugin: inspect provenance, capabilities, permissions, and supply-chain posture, then return an evidence-backed enable or block verdict.
---

# Plugin Audit (builtin.plugin-audit)

Audit an extension or plugin before it is enabled: where it comes from, what it
can do, what it asks to touch, and how healthy its supply chain is. The output is
a verdict — ENABLE, ENABLE-WITH-RESTRICTIONS, or BLOCK — with evidence for every
claim. Enabling is a decision for the user; this skill only produces the verdict.

## When to use

- A plugin, extension, or MCP server is about to be installed or enabled.
- A plugin update changed its permissions or capabilities and needs re-review.
- An audit of currently enabled plugins is requested.
- A plugin recommendation arrives from a third party or an automated source.

## Workflow

1. Identify the artifact precisely: source (registry, git URL, local path), exact
   version or commit, and the file that would load it. Record how it is resolved.
2. Read the manifest: declared capabilities, permissions, hooks, commands, and any
   requested file, network, or subprocess access. Note anything the manifest omits.
3. Assess provenance: author or organization history, repository age and activity,
   maintainer count, license, release cadence, and whether the version is signed
   or pinned to a commit.
4. Inspect the code surface: read entry files and hook handlers for network calls,
   credential access, subprocess execution, filesystem writes outside the workspace,
   and attempts to bypass admission or the Guard.
5. Compare declared versus observed: every capability the code exercises must
   appear in the manifest; undeclared behavior is a finding on its own.
6. Assess supply chain: dependency count, unpinned or install-time-script
   dependencies, typosquat distance from the intended package, and integrity pins
   in the manifest or lockfile.
7. Check session posture: which lane it would run in, what the Guard would admit,
   and what restrictions (network off, workspace-only writes) could contain it.
8. Rank findings by severity and issue the verdict with the restrictions that
   would make an ENABLE acceptable.
9. Present the verdict to the user; do not enable the plugin in this skill.

## Output contract

- Identity: source, version or commit, resolution path, and license.
- Capabilities and permissions: declared list, plus anything observed but undeclared.
- Findings: severity, evidence (file and line or manifest key), and impact.
- Supply chain: dependency and pinning posture with specifics.
- Verdict: ENABLE, ENABLE-WITH-RESTRICTIONS, or BLOCK, with rationale and
  restrictions.

## Honesty rules

- The verdict rests on evidence read this session, not on reputation or popularity alone.
- Never enable, install, or grant permissions in this skill; verdicts only.
- An absent or unreadable manifest is a High-severity finding, never a pass.
- Mark any uninspected code path UNKNOWN and weigh it into the verdict.
- Report PARTIAL when the source could not be fetched, with the exact reason.