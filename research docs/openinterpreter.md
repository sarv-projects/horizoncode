# Open Interpreter: current Rust/Codex-derived coding harness

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `419d992bc6132c64ef9ec1882a6de9d2ca9a3853`. This note describes the current public Rust tree, not the historical Python-only product description.

## HLD

The current repository is a Rust coding-agent harness derived from Codex architecture, with a Codex-like CLI/runtime and compatibility surfaces for multiple agents/providers, including ACP and Codex exec-style workflows. The large `codex-rs` workspace and `codex-cli` are central. Provider/harness adapters and a desktop/workstation surface aim to let users select or host different coding runtimes. Because this is a fork, shared shape or behavior does not establish parity with upstream Codex.

## LLD and configuration

The CLI uses TOML configuration and profiles to select model/provider endpoints, execution sandbox and approval behavior. Local provider/server endpoints are supported. Execution modes documented in the current project include read-only, workspace-write and unrestricted/danger-full-access; approval policies include untrusted, on-request and never. Compatibility paths include ACP and Codex exec-style operation. Specific feature parity and event schemas must be checked at the pinned branch, not inferred from upstream names.

The core operational flow is request/session → model and tool loop → permission/sandbox enforcement → workspace/process operations → structured agent response. A Codex-derived thread/turn/event/item model is a plausible source pattern, but this note does not claim every upstream schema is unchanged in this fork; inspect the exact Rust modules and migrations before relying on field-level compatibility.

## Safety boundary

Sandbox and approval are separate controls. The `--yolo` / dangerous bypass path removes sandbox/approval safeguards and must not be used for untrusted or unattended production work. A fail-closed policy is meaningful only when the requested isolation backend can actually enforce it. Validate effective settings after profile/environment/CLI overrides.

## Relevance to HorizonCode

Study provider/harness compatibility, local endpoint configuration and sandbox policy composition. Treat Open Interpreter as an upstream-derived peer adapter candidate, not as an independent proof of Codex correctness. For any subprocess integration record exact binary path/version, arguments, effective config, sandbox, protocol capabilities and workspace revision.

## Sources

[Current README](https://github.com/openinterpreter/openinterpreter/blob/main/README.md) · [Sandbox and approvals](https://github.com/openinterpreter/openinterpreter/blob/main/docs/sandbox.md) · [Configuration](https://github.com/openinterpreter/openinterpreter/blob/main/docs/config.md) · [Quickstart](https://github.com/openinterpreter/openinterpreter/blob/main/docs/quickstart.md) · [Pinned source tree](https://github.com/openinterpreter/openinterpreter/tree/419d992bc6132c64ef9ec1882a6de9d2ca9a3853)
