# Research and test documents

This directory contains source-mapped research notes, benchmark/test strategy, and the
product overview moved out of the repository root. These notes describe what their
sources document; they are not endorsements, proof of comparative quality, or permission
to copy source code. Check the linked upstream revision and its license before relying
on a volatile implementation detail.

## Product and architecture research

- [Project overview](PROJECT-OVERVIEW.md)
- [Long-horizon coding-agent architecture landscape](long-horizon-architecture.md)
- [Long-horizon harness source review](long-horizon-repo-review.md) — DeerFlow, LongHorizon-Harness, DeepSeek-Harness, DeepCode, and Plandex at pinned revisions.
- [Agent ecosystem source review](agent-ecosystem-review.md) — Ruflo, Kilo, ECC, Hermes, Superset, CodeBurn, Nanobot, and wshobson/agents.
- [UI, runtime, tools, and optimization review](ui-runtime-tools-review.md) — OpenHuman, OpenHands, AiderDesk, DeepSeek-Reasonix, code-review-graph, Serena, ripgrep, ast-grep, and related candidates.
- [Warp and oh-my-pi runtime review](warp-ohmypi-review.md) — pinned orchestration, provider registry, persistence, compaction, permissions, and recovery paths; test-path coverage limitations are explicit.
- [Research landscape and source index](research-landscape.md)
- [Test strategy and benchmark plan](tests.md)

## Coding-agent source maps

- [Aider](aider.md)
- [Claude Code](claude.md) — public documentation only; implementation is not public.
- [Cline](cline.md)
- [Codex](codex.md)
- [Codex memory pipeline](codex-memory.md) — memory-specific source review and limits.
- [OpenCode](opencode.md)
- [OpenCode provider and authentication inventory](opencode-provider-inventory.md) — pinned provider directory, auth-method/source map, and coverage limits.
- [Qwen Code](qwen-code.md)
- [MiMo-Code](mimo-code.md) — OpenCode-derived fork; compare its deltas separately.
- [Open Interpreter](openinterpreter.md)
- [DeepCode](deepcode.md)
- [DeepSeek-Reasonix](deepseek-reasonix.md)
- [jcode](jcode.md)
- [Ouroboros](ouroboros.md)
- [Hermes Agent](hermes-agent.md)
- [cc-haha](cc-haha.md) — third-party Claude Code workspace, not Anthropic source.

## Related tool maps

- [RTK](rtk.md)
- [Code Review Graph](code-review-graph.md)
- [Serena](serena.md)
- [Superset](superset.md)
- [CodeBurn](codeburn.md)
- [Command Code](command-code.md)
- [Grok Build workflows](grok-build-workflows.md) — pinned authoring/runtime pattern review.
- [Helix editor architecture](helix-editor.md) — module-boundary comparison only; no code reuse.

## Authority

The product contract and architecture live in [`../ARCH/`](../ARCH/00-INDEX.md).
The current implementation/status handoff is [`../CURRENT_RUN.md`](../CURRENT_RUN.md),
and the delivery ledger is [`../TODO.md`](../TODO.md). For evidence rules, use
[`../ARCH/23-VERIFICATION.md`](../ARCH/23-VERIFICATION.md); this directory's
[`tests.md`](tests.md) gives the concrete test and benchmark plan.
