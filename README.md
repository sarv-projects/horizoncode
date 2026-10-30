# HorizonCode

**An open-source coding agent for your terminal, with guarded execution and verifiable results.**

HorizonCode takes software tasks from description to implementation. It explores repositories, edits code, runs commands, and verifies changes — while a Rust execution kernel controls how tools interact with your workspace.

Unlike agents that rely entirely on their conversation history to report success, HorizonCode records authorised effects and their outcomes.

<p align="center">
  <img src="docs/assets/horizoncode-hero.svg" alt="HorizonCode" width="100%" />
</p>

## What can you do with HorizonCode?

- **Build features:** Describe a task and let the agent explore the codebase, implement changes, and run tests.
- **Debug existing code:** Investigate unfamiliar repositories, identify problems, and apply fixes.
- **Work with your tools:** Execute shell commands, read and edit files, and use supported integrations.
- **Control execution:** Choose whether the agent can freely modify files, must request approval, or is restricted to read-only operations.
- **Inspect outcomes:** Review recorded execution receipts instead of relying solely on the agent's claims.

## Why HorizonCode?

Most coding agents put the model in charge of deciding what tools to call. HorizonCode separates the agent's reasoning from the authority to perform mutations.

A TypeScript/Bun runtime handles the agent loop and terminal interface. A Rust kernel controls execution admission, permissions, leases, effects and receipts.

This separation is the foundation of HorizonCode: **the model can request an action, but it cannot independently authorise that action.**
