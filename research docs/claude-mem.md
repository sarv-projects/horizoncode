# claude-mem — public memory lifecycle review

Reviewed 2026-09-29. This is a focused review of public documentation, one pinned
hook manifest, and issue reports, not a full source audit. The reviewed release is
[`ed57a511f5dbf84e75c9a785df818c43b66b5849`](https://github.com/thedotmack/claude-mem/tree/ed57a511f5dbf84e75c9a785df818c43b66b5849)
(v13.24.23, dated 2026-09-11). The pinned [`plugin/hooks/hooks.json`](https://github.com/thedotmack/claude-mem/blob/ed57a511f5dbf84e75c9a785df818c43b66b5849/plugin/hooks/hooks.json)
manifest was inspected; its [Apache-2.0 license](https://github.com/thedotmack/claude-mem/blob/ed57a511f5dbf84e75c9a785df818c43b66b5849/LICENSE)
allows source inspection. Hook implementation files were not fetched or read.
Public docs identify names such as `context-hook.js`, `new-hook.js`, `save-hook.js`,
and `summary-hook.js`; treat them as navigation leads, not inspected code.

## Publicly documented flow

The project README and public hook documentation describe a local worker service and SQLite-backed observations,
with lifecycle hooks that expose recent project context at session start, capture
prompts, queue post-tool observations for later compression, summarize at stop, and
close the session at session end. Its MCP search surface is progressive: search for
relevant observations, inspect a timeline, then fetch selected records. These are
project documentation claims, not an independently run implementation or performance
result. The README's token-savings figure is not used as a HorizonCode benchmark.

The documentation says `<private>` blocks are excluded. This is a useful explicit
user control, but it is not general secret detection. The docs also describe an
optional model-backed compression path; unless a local model is selected, operators
must account for the configured model/provider data-egress boundary. “Local SQLite”
does not by itself mean all processing stays local.

The pinned hook manifest registers `SessionStart` context handling for `startup`,
`resume`, `clear`, and `compact`. A maintainer-authored open
[plan/issue #3608](https://github.com/thedotmack/claude-mem/issues/3608) groups
reports of inconsistent project-key resolution across capture/read paths, injection
filters that did not reach every query, subagent observations displacing main-agent
history, and non-idempotent/volatile injection. A related [issue #4061
report](https://github.com/thedotmack/claude-mem/issues/4061) describes duplicated
context on resume for a specific release/setup. These are issue/plan claims, not
independent reproduction of every defect at the reviewed pin. They provide concrete
failure classes: use one project identity resolver and immutable scope, keep child
observations out of shared retrieval unless explicitly selected, key injection to the
Thread/context epoch, avoid re-injecting already-present context on resume, and render
stable text so timestamps do not defeat provider prefix caching.

## Subagent memory evidence

Current official [Claude Code subagent documentation](https://code.claude.com/docs/en/sub-agents)
and [memory documentation](https://code.claude.com/docs/en/memory) describe a
different default from copying the parent's transcript: a normally spawned subagent
starts with fresh context, receives its delegation and applicable configuration, and
does not automatically inherit the parent's conversation or auto-memory. A subagent
may have its own profile-scoped memory when configured; the documented memory file
injection is bounded (first 200 lines or 25 KB). Skills can be explicitly preloaded,
which puts their full body into the child's context. This is behavior documented for
Claude Code; it does not imply ACP or opaque CLI adapters expose equivalent controls.

Anthropic's [hook reference](https://code.claude.com/docs/en/hooks) documents a
`SubagentStart` hook with the child `agent_id` and `agent_type`. The hook may append
`additionalContext` before the first prompt, but cannot block creation. When invoked
again, it avoids appending a copy that is still present; after compaction removes the
copy, a later hook invocation adds it again. This is a useful delivery behavior, not
a durable authorization gate or cross-process replay guarantee. For HorizonCode, the
controller must construct and authorize the packet before spawn; any adapter-specific
hook can only deliver that pinned packet. Horizon's own dispatch/epoch digest governs
retry, recovery, and intentional refresh.

A historical [claude-mem issue #1464](https://github.com/thedotmack/claude-mem/issues/1464)
reported that, in a v10.5.6/experimental Agent Teams setup, child agents received
duplicated inherited memory/configuration and increased token use with fan-out. It is
a user report tied to that version and setup, not proof of a current defect or a
resolved fix in later releases. It motivates measuring fan-out cost and identifying
the source and byte/token size of every injected context item.

## HorizonCode disposition

Adopt the architectural lesson, not the code: each worker receives a bounded,
revision-bound `ContextPacket`; default history fork and profile memory are disabled;
only selected, accepted, current, task-relevant records may be added under explicit
user/managed policy and a negotiated adapter capability. Record exact memory IDs,
revisions, digests, and skill/context references in `ContextEpoch`. Child writes go
through the existing reviewable memory-candidate flow. Parent and sibling memory are
not copied implicitly. Context injection is data, never authority or verification
evidence. Report included/excluded sources and actual per-dispatch token/cost
observations when available; unknown external usage remains unknown.

Required tests are owned by `AX-371` and `research docs/tests.md`: fan-out cost,
per-profile/project/user isolation, stale-source exclusion, disabled memory, explicit
sharing, external capability negotiation, nested subagents, prompt injection,
duplicate hook delivery after restart/compaction, and unavailable/corrupt memory
storage. No code has been copied or tests run as part of this documentation review.

## Sources and limits

- [claude-mem pinned public repository](https://github.com/thedotmack/claude-mem/tree/ed57a511f5dbf84e75c9a785df818c43b66b5849)
- Pinned [`plugin/hooks/hooks.json`](https://github.com/thedotmack/claude-mem/blob/ed57a511f5dbf84e75c9a785df818c43b66b5849/plugin/hooks/hooks.json) and [Apache-2.0 license](https://github.com/thedotmack/claude-mem/blob/ed57a511f5dbf84e75c9a785df818c43b66b5849/LICENSE)
- [Project identity and injection-scope issue/plan #3608](https://github.com/thedotmack/claude-mem/issues/3608)
- [SessionStart resume duplicate report #4061](https://github.com/thedotmack/claude-mem/issues/4061)
- [claude-mem issue #1464](https://github.com/thedotmack/claude-mem/issues/1464)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) — `SubagentStart` input, `additionalContext`, and repeat/compaction behavior.
- The third-party `codeaashu/claude-code` README identifies its contents as leaked,
  proprietary source and states that it is not licensed for redistribution. That
  repository's source tree and backup branch were not inspected or used. Its README
  claims are excluded from architecture evidence. See [`claude.md`](claude.md) for
  the provenance boundary and public-document-only Claude Code review.
