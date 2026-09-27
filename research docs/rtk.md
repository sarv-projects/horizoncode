# RTK: command-output filtering and agent hooks

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: develop, commit `45b0b4c39c5ce931b364aae25d6fb00ec877c346`; latest listed release v0.49.0 (2026-09-11). Focused audit of command rewriting, filters, hooks and local tracking; RTK is not an autonomous coding agent.

## HLD

RTK is a Rust CLI that intercepts/re-writes common developer commands so their output is shorter for an LLM-facing terminal. It has built-in command filters, user-defined TOML filters, host-specific hook installers, optional local history/analytics, and retrieval paths for full output. The intended invariant is graceful fallback to the original command/output when a filter cannot safely process the result.

## LLD and schema

The dispatcher recognizes commands and selects a route/filter; a guard compares filtered output with the raw result and can preserve raw output if the filter is not useful or fails. Filter stages include ANSI removal, regex replacement, output matching, strip/keep, truncation, head/tail, line caps and empty-output behavior. Filter sources have precedence across trusted project configuration, user configuration and built-ins; project config requires explicit trust. Hook integrations rewrite shell calls across supported agent hosts using a shared registry of command patterns.

The SQLite history schema described by the project includes command records (time, original and rewritten command, working directory, approximate input/output/saved tokens, reduction percentage and duration), parse failures and hook decisions. Raw command output may be retained content-addressably for later retrieval. Token counts are byte-based estimates (roughly bytes/4), and percentage reduction is output-volume reduction—not measured provider-bill savings.

## Flows

1. Agent host invokes shell command.
2. Installed host hook receives its JSON request and rewrites recognized command to RTK form.
3. RTK executes/filters command, applies fallback guards, records local summary and optionally raw output.
4. Hook returns transformed shell text/result to the original host.
5. User or agent can inspect full raw output through retrieval when the summary is insufficient.

Permission policy combines explicit allow/ask/deny and host capabilities; the documented precedence puts deny above ask, ask above explicit allow, then default ask. Host protocols differ, and some do not expose a genuine “ask” decision. The hook's own failure behavior is part of the safety contract: current docs identify an invalid-JSON path in `run_gemini()` that exits nonzero despite the stated fail-open goal. The Claude hook checker warns on staleness, but equivalent freshness checking is not uniformly documented for every host.

## Reliability, privacy, and limits

- Summarization can remove diagnostics needed for a correct decision. Keep raw output recoverable and test omission rates on real tasks.
- Filtering a shell command is a semantic rewrite; user command quoting, pipelines, environment, cwd and shell behavior need adversarial tests.
- Hooks are host-specific glue that can drift with upstream protocol changes. Installer idempotence and rollback matter.
- Local logs can expose paths, commands, and output. Define retention, redaction, consent, and project trust boundaries.
- “Up to 90%” style reduction claims are not equivalent to 90% lower model cost or unchanged task quality.

## Relevance to HorizonCode

The useful pattern is two-tier output: concise task-oriented summaries with immutable/raw evidence retrievable by reference. In HorizonCode, store the raw output digest and exact command/environment, then mark which projection the worker saw. Never let a token-saving filter erase verification evidence. Prefer implementing focused filters behind a typed tool-output projection interface instead of silently rewriting arbitrary shell strings.

## Primary references

[Core README/schema](https://github.com/rtk-ai/rtk/blob/develop/src/core/README.md) · [Hook architecture](https://github.com/rtk-ai/rtk/blob/develop/src/hooks/README.md) · [Installed hooks](https://github.com/rtk-ai/rtk/blob/develop/hooks/README.md) · [Technical architecture](https://github.com/rtk-ai/rtk/blob/develop/docs/contributing/TECHNICAL.md) · [Releases](https://github.com/rtk-ai/rtk/releases)
