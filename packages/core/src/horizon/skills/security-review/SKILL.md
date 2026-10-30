---
name: security-review
description: Use when defensively reviewing code or config for secrets exposure, injection, unsafe deserialization, authz gaps, and dependency risk, returning severity-ranked findings with remediation.
---

# Security Review (builtin.security-review)

Defensive review of code and configuration for exposure and misuse risks: leaked
secrets, injection into unsafe sinks, unsafe deserialization, authorization gaps,
and dependency risk. Findings are severity-ranked with file:line evidence and a
concrete remediation. This skill contains no offensive or exploitation guidance.

## When to use

- Before merging code that handles input, auth, files, or credentials.
- A config or permission change needs a safety check.
- A release gate requires a security pass with recorded findings.
- An audit of tracked files for accidentally committed secrets is requested.

## Workflow

1. Fix the scope: the files, routes, or configs under review and what they touch
   (network, filesystem, subprocess, credentials, user data). State the boundary.
2. Scan for secrets in tracked files only: grep for key, token, password, and
   credential patterns; also check sample configs and fixtures. Never print a full
   secret value in the report — redact it and cite the path plus a rotation step.
3. Trace untrusted input to sinks: follow request, env, file, and message input
   into query builders, exec and spawn calls, template renderers, deserializers,
   and eval-like paths. Cite the validation present or missing at each hop.
4. Check authorization on mutating operations: who may invoke each route or command,
   where the check happens, and whether any path admits a mutation without the
   same admission the Guard enforces elsewhere.
5. Check unsafe deserialization and parser risks: untrusted input reaching revive,
   prototype-polluting merges, permissive YAML loading, or pickle-like loaders.
6. Assess dependencies from the lockfile: pinned versions, known-vulnerable ranges
   from advisories or local audit tooling, and install scripts that run at install time.
7. Check configuration exposure: debug modes, permissive CORS, world-readable
   permissions, verbose errors leaking internals, and default credentials.
8. Rank findings: Critical (direct exposure), High (likely exploitable gap),
   Medium (missing defense), Low (hardening). Write remediation per finding.
9. Note observed positive controls so the reader knows what is already defended.

## Output contract

- Scope: what was reviewed and the explicit boundary of the pass.
- Findings: severity, category, file:line, evidence (redacted), remediation.
- Dependency risk: vulnerable or unpinned packages with the advisory source.
- Positive controls: defenses observed, at most three.
- Coverage gaps: files or paths not reviewed, marked UNKNOWN.

## Honesty rules

- Defensive review only: no exploit steps, payloads, or attack tutorials.
- Every finding cites code or config actually read this session.
- Redact secret values in the report; cite the path and rotation step instead.
- A missing manifest, lockfile, or auth check is itself a finding, not a pass.
- Report PARTIAL when scope could not be fully read, naming the unread portion.