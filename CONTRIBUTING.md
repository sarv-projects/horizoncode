# Contributing to HorizonCode

HorizonCode is an experimental, source-build coding-agent project. Contributions are welcome across guarded tool execution, managed long-horizon work, performance, integrations, tests and user experience. **This is HorizonCode's contributor workflow**, not a copy of upstream OpenCode's issue/PR policy. The original upstream guide is retained in [opencode/CONTRIBUTING.md](opencode/CONTRIBUTING.md).

## Start with the implementation truth

Read [AGENTS.md](AGENTS.md) for coding-agent rules, [HANDOFF.md](HANDOFF.md) for what the live source has actually implemented, and [arch_V1/README.md](arch_V1/README.md) for normative topic ownership. Consult only the relevant topic owner, [the single operative implementation plan](docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md), the source seam [§20](arch_V1/20-OPENCODE-INTEGRATION-LLD.md) and the test catalog [§32](arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md). Historical plans and architecture files under `docs/architecture-archive/` are not implementation instructions.

The root `packages/` directory contains HorizonCode overlays **and** files restored from the pinned `opencode/` snapshot by the repository bootstrap script. In a fresh checkout, do not interpret a file absent from root `packages/` as an unimplemented feature until the pinned source has been restored and inspected. Keep Horizon modifications in the sanctioned overlay; do not rewrite the upstream snapshot and overlay independently.

## Development environment

Linux, Git, Python 3, Bun 1.3.14 and a Rust toolchain are the documented developer-preview baseline. Native Windows/macOS execution, isolation and installer claims require separate platform evidence.

```bash
git clone https://github.com/sarv-projects/horizoncode.git
cd horizoncode

python3 scripts/architecture/bootstrap_source.py --apply
bun install --frozen-lockfile
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor
bun run dev
```

These are **development commands**, not an official installer or published HorizonCode binary. For a proposed change, inspect the actual implementation and tests in the hydrated source first.

## Submitting a change

1. Identify the **single canonical owner**: Core owns direct Sessions and provider-turn continuation; Rust owns managed Run/Task/Attempt state, Guard, effect receipts and resource/worktree leases. Don't introduce a competing Session store, tool registry, model picker, scheduler or authorization engine.
2. State the intended user-visible behavior and link to the applicable architecture decision, source function and acceptance ID. If a change materially alters an architecture decision, update §17, the topic owner, relevant schemas, §32 tests and the operative plan **in the same PR**.
3. Add a failing targeted test first, then implement a narrow change with real positive, denied, adversarial and restart/cancellation/UNKNOWN cases for effectful behavior. An API response, compiled schema or UI toggle alone is not a released feature.
4. Keep provider/model/harness choices explicit; do not add hidden paid fallback, model impersonation, uncontrolled network calls, silent data export or weakened sandbox claims.
5. Include exact test commands, platform, source SHA and observed output. Performance claims require comparable end-to-end tasks and measured **whole-process-tree** CPU/RAM/PSS/FD/disk outcomes, not upstream marketing numbers.
6. Inspect git status, active processes, worktrees and disk usage before and after the task. Only clean disposable outputs you own; never delete dirty/untracked user worktrees or global caches to make a benchmark look better.

## Validation

```bash
bash scripts/architecture/run_push_gate.sh
bash scripts/architecture/run_full_gate.sh
```

The full gate may require a restored, installed and suitably provisioned source tree. GitHub Actions jobs are additional evidence and must be checked for the **final head commit**. A green TypeScript typecheck does not imply Rust production execution, OS security containment or a verified end-to-end coding task.

## Issues, security and licensing

Use [HorizonCode issues](https://github.com/sarv-projects/horizoncode/issues) for non-sensitive bugs, design discussion and missing test evidence. Follow [SECURITY.md](SECURITY.md) for security disclosures; never publish a live exploit or token in a public issue.

HorizonCode incorporates a pinned upstream snapshot with attribution and license obligations. **The reviewed tree does not currently contain a root LICENSE file.** Until the project's redistribution/license decision and upstream notice review are completed, contributors should not assume a finalized HorizonCode licensing grant or claim release readiness. Do not copy third-party source or assets without reviewing [the source-provenance register](arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md). This warning documents an unresolved gate; it does not substitute for a proper license.
