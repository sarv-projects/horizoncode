# HorizonCode

**A terminal-native coding agent for substantial, multi-step work in your repository.**

> **In development** — HorizonCode is still being built. The product description below describes the intended application; release and installation instructions will be published when they are ready.

HorizonCode is designed for work that takes more than a single prompt: understand a codebase, agree on what “done” means, make a plan, carry out the work, and show the evidence behind the result. Runs are designed to remain inspectable and resumable, with task progress kept separate from conversation history and completion tied to verification.

## Work that stays understandable

HorizonCode keeps the request, plan, repository changes, approvals, and verification evidence connected throughout a run.

- **Plan before execution.** Turn a request into explicit requirements, acceptance conditions, and a dependency-aware task plan. Clarify consequential assumptions before work begins.
- **Keep long work on track.** Persist run and task history, budgets, checkpoints, and decisions so work can pause, resume, and recover without inventing progress.
- **See what is happening.** Follow the conversation, repository files, task graph, attempts, and evidence in a keyboard-first terminal workspace. On narrower terminals, focus one surface at a time without losing its state.
- **Verify the result.** Check work against the agreed conditions and bind evidence to the repository revision it covers. A worker saying it is done is not the same as a verified task.
- **Stay in control.** Review consequential actions, inspect the effective permission boundary, and see what the execution environment can enforce. Unsupported isolation or policy requirements are surfaced instead of implied.

## Designed for real repository work

### A persistent task plan

Each run begins with the original request and a reviewable plan. Tasks record their dependencies, scope, acceptance conditions, execution attempts, and verification evidence. Changes to confirmed behavior require a new reviewed specification; technical discoveries can update the plan without silently rewriting the request.

Runs can wait for clarification, permission, or an external dependency. Budgets and concurrency limits bound execution, while durable history and recovery records make interruptions visible and actionable.

### A workspace built around the code

The interactive terminal workspace keeps chat at its center, with a repository explorer and task view alongside it. Open files and diffs without losing the conversation. When the terminal is too narrow for several panes, switch between focused views and return to the same work.

Repository context is designed to include current files, symbols, instructions, and change history. Context can be compacted for long sessions while preserving the source and task evidence needed to continue.

### Governed tools and execution

File changes, shell commands, network access, and other effects pass through a common policy and audit path. Policies can allow, ask, or deny actions within the limits of the host's actual enforcement mechanisms. The interface identifies the applicable boundary and its limitations; a permission prompt alone is not represented as operating-system isolation.

### Model and agent choice

Use configured hosted or local model routes when their authentication and required capabilities are supported. Connect other coding agents through the Agent Client Protocol (ACP), and extend tool access through the Model Context Protocol (MCP). Protocol and provider support is capability-aware; a compatible-looking endpoint or registered integration does not automatically imply support or trust.

### Parallel work with independent checks

When tasks are independent and the configured limits allow it, HorizonCode can assign work to isolated attempts or connected agents. It tracks each attempt, reviews the resulting changes, and verifies the integrated revision before dependent work can proceed. Delegation is bounded by the run's permission and resource limits.

## Run it where you work

HorizonCode is intended to run on a developer's workstation or on a server they manage. A self-hosted server does not require a HorizonCode-operated cloud service, and does not by itself provide remote UI access. The selected model provider may receive the request and repository context needed for the chosen route; that data flow is governed separately from local execution and workspace access.

## Project documents

- [Vision](ARCH/01-VISION.md) — product direction, audience, and non-goals
- [Requirements](ARCH/02-REQUIREMENTS.md) — observable product requirements
- [Architecture index](ARCH/00-INDEX.md) — design documents and their authority
- [Security model](ARCH/22-SECURITY.md) — permission, confinement, and security boundaries
- [Verification](ARCH/23-VERIFICATION.md) — evidence and acceptance approach
- [Contributor guide](AGENTS.md) — repository workflow and documentation rules

## Contributing

Start with the [contributor guide](AGENTS.md) to find the owning design, preserve source provenance, and validate changes.

## License

HorizonCode is distributed under the [Apache License 2.0](LICENSE).
