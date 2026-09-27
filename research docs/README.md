# Research and test documents

This directory contains source-mapped research notes, benchmark/test strategy, and the
product overview moved out of the repository root. These notes describe what their
sources document; they are not endorsements, proof of comparative quality, or permission
to copy source code. Check the linked upstream revision and its license before relying
on a volatile implementation detail.

## Product and architecture research

- [Project overview](PROJECT-OVERVIEW.md)
- [Long-horizon coding-agent architecture landscape](long-horizon-architecture.md)
- [Research landscape and source index](research-landscape.md)
- [Test strategy and benchmark plan](tests.md)

## Coding-agent source maps

- [Aider](aider.md)
- [Claude Code](claude.md) — public documentation only; implementation is not public.
- [Cline](cline.md)
- [Codex](codex.md)
- [OpenCode](opencode.md)
- [Qwen Code](qwen-code.md)
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

## Authority

The product contract and architecture live in [`../ARCH/`](../ARCH/00-INDEX.md).
The current implementation/status handoff is [`../CURRENT_RUN.md`](../CURRENT_RUN.md),
and the delivery ledger is [`../TODO.md`](../TODO.md). For evidence rules, use
[`../ARCH/23-VERIFICATION.md`](../ARCH/23-VERIFICATION.md); this directory's
[`tests.md`](tests.md) gives the concrete test and benchmark plan.
