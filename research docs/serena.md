# Serena: symbol-level coding tools and IDE-backed code intelligence

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `7a2968335f2198b966864de1ce3655c8e485a653`. Focused audit of tool architecture, project activation, JetBrains integration and licensing.

## HLD

Serena is a coding-tool server, not a complete autonomous agent. A Python MCP-facing project server uses SolidLSP language-server wrappers to provide symbol-aware navigation and editing across many languages. It can also expose an experimental REPL interface. The model/runtime calling these tools is external.

The project configures tool exposure/context modes, activates a repository, initializes language tooling/indexes and routes symbol operations through either an LSP-backed or IDE-backed backend. Configuration may be global, user-level or project-scoped; project activation establishes root and language context.

## LLD and editor distinction

The JetBrains plugin is an IDE backend connection, not a replacement editor shell or a complete autonomous workflow UI. A coding-agent client communicates through the plugin to use the IDE's symbol/refactor services and debugger-like operations. The documented workflow expects the project to be open in the IDE; one IDE instance is shared by connected agent sessions. The backend choice is made at server startup, and external edits may require IDE/LSP synchronization.

Tool calls operate on semantic units (symbols/references/definitions/rename/edit) rather than only line-oriented text. This can reduce broad file reads and make changes more precise, but it does not establish whether a task is fully implemented, tests pass, or a long-running task can recover.

## Flows

Agent client → MCP/REPL server → active project/config → selected language/IDE backend → language-server or JetBrains semantic operation → structured result to agent. Project activation and backend availability are prerequisites; errors in them should be visible rather than silently falling back to unreliable text edits.

## Limits and source policy

- Serena does not own planning, durable task graphs, verification, worker isolation or test execution.
- Semantic results depend on language-server coverage, indexing state, workspace synchronization and accurate project-root selection.
- An IDE plugin's process/session lifecycle differs from durable agent task state; HorizonCode must own its recovery and audit trail.
- Licensing is component-specific: Serena application is GPL-3.0-or-later while SolidLSP is MIT. HorizonCode's current source policy bars copyleft code, so use this as an interface/pattern reference only unless policy changes. [License](https://github.com/oraios/serena/blob/main/LICENSE).

## Relevance to HorizonCode

The useful slice is an optional semantic repository-tool adapter, particularly for rename/reference/call-graph tasks, with explicit capability and freshness metadata. Treat LSP/IDE changes as tool effects that require workspace revision tracking and subsequent independent compilation/tests.

## Primary references

[README](https://github.com/oraios/serena) · [Workflow](https://github.com/oraios/serena/blob/main/docs/02-usage/040_workflow.md) · [JetBrains plugin](https://github.com/oraios/serena/blob/main/docs/02-usage/025_jetbrains_plugin.md) · [Configuration template](https://github.com/oraios/serena/blob/main/src/serena/resources/serena_config.template.yml) · [License](https://github.com/oraios/serena/blob/main/LICENSE)
