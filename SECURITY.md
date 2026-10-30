# HorizonCode security policy

HorizonCode is currently a **source-build developer preview**, not a production-ready sandbox. The implementation status and supported-platform qualifications are described in [HANDOFF.md](HANDOFF.md). The design and intended protections are in [the threat model](arch_V1/05-SECURITY.md) and [effect/ExecutionHost contracts](arch_V1/14-EFFECTS-EXECUTION-SECURITY.md); **a design is not proof that a protection is enforced**.

## Current risk and support status

- The OpenCode-derived application can execute tools and interact with local files and external services. The existing Rust Guard covers a narrow approved `files.write` path; mediation of all shell, subprocess, plugin, MCP, subagent, hosted-provider and other effect origins remains an open implementation/release gate.
- Do **not** treat permission prompts, a container label, an experimental toggle, a read-only-looking tool, or the presence of Rust code as comprehensive isolation. Do not run untrusted repositories, prompts, scripts, extensions, remote endpoints or MCP servers with access to sensitive accounts or files on the assumption that they are sandboxed.
- Bind any local HTTP server to an appropriate trusted interface and configure authentication; do not expose a development server or private kernel socket publicly. The inherited OpenCode server's actual settings are determined by the running source/version—do not assume an unverified Horizon security default.
- Provider requests, connected plugins, tool outputs, project files and logs can contain sensitive data. Read a selected provider's data-handling terms; never place API keys, tokens or private proof-of-concept payloads in public issues, logs, screenshots or benchmark artifacts.
- Native Windows, macOS and specific Linux confinement backends require independent tested capability matrices. WSL is not native Windows qualification. If the requested isolation guarantee is unsupported, the execution route must be disabled rather than silently downgraded.
- No general security warranty or formal supported-version window is offered for the unreleased preview. A future release policy must explicitly identify supported versions, platforms and boundaries.

## Reporting a security vulnerability

Report vulnerabilities to the **HorizonCode** maintainers, not to the separate OpenCode upstream team. Check [HorizonCode's GitHub Security tab](https://github.com/sarv-projects/horizoncode/security) for a private **Report a vulnerability** option, if enabled. If it is not available, open a [HorizonCode issue](https://github.com/sarv-projects/horizoncode/issues) requesting a private reporting contact **without including exploit steps, secrets or sensitive technical details in the public issue**. Do not send HorizonCode reports to OpenCode's advisory page or its email address.

For a private report, provide the tested HorizonCode commit/version, OS and sandbox profile, affected path and capability, minimal safe reproduction, expected vs observed outcome, impact and whether a similar issue affects the pinned upstream source. Redact credentials and unrelated personal information. Avoid testing on accounts or resources without authorization.

## Scope and attribution

The pinned upstream source has its **own** policies, notices and original security documentation, retained in the local pinned `opencode/` snapshot at `opencode/SECURITY.md`; that directory is untracked reference material and is not part of the tracked tree. Those do not automatically describe HorizonCode's implementation, protect HorizonCode's users or define where HorizonCode vulnerabilities are reported. If an issue demonstrably also affects upstream OpenCode, coordinate a separate private disclosure through its supported channel without disclosing someone else's confidential report.

Release claims require the §32 acceptance/security tests, the full platform-specific no-bypass matrix, approved packaging/attribution and actual evidence; this Markdown policy does not mark them completed.
