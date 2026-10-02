# HorizonCode

**A powerful, all-purpose coding agent for quick fixes and long-running work.**

> **In progress** — HorizonCode is under development.

HorizonCode is being built to understand unfamiliar code, find bugs, build features, run tests, and review changes. The target product supports focused work in a conversation and larger **Managed Runs** that carry goals, plans, tasks, decisions, and verification across steps and sessions. See [`TODO.md`](TODO.md) for what is implemented and what remains.

## Your project stays in view

The planned full-screen workspace puts the file Explorer on the left, chat in the center, and a clear task list on the right. It is designed to open source files without leaving the conversation and let users inspect task changes, attempts, and checks. On a small terminal, the target layout focuses on one area at a time.

The intended interaction is to ask HorizonCode to explore code, make a plan, edit files, and run commands. The design requires users to review the diff and evidence behind a result before calling work done.

## Built for the work that takes longer

The target Managed Run records the requested outcome, breaks work into dependent tasks, and tracks progress, approvals, budgets, and checkpoints. Its design supports pausing, resuming, and reviewing what changed and remains; completion requires checks against the agreed result.

## Your setup, your choice

The target product can run on a workstation or a server the user manages, use configured hosted or local model routes, connect compatible agents through ACP, and connect external tools through MCP. Its planned Extensions manager brings skills, MCP servers, plugins, and hooks together. These capabilities are delivered incrementally; check [`TODO.md`](TODO.md) before relying on any specific feature.

The target security model keeps workspace execution on the selected execution host and presents the applicable approvals and protections. The selected provider receives the prompt and code context required for its route; exact data flows and enforcement remain subject to the configured provider and verified platform capability.

## Learn more

- [Product vision](ARCH/01-VISION.md)
- [Requirements](ARCH/02-REQUIREMENTS.md)
- [Architecture index](ARCH/00-README.md)
- [Workspace design](ARCH/product/UI.md)
- [Security model](ARCH/security/SECURITY-MODEL.md)
- [Contributing](AGENTS.md)
- [License](LICENSE)
