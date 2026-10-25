> **In progress.** HorizonCode V1 is not yet released. Follow the [implementation handoff](HANDOFF.md) for current verification and release status.

<p align="center">
  <img src="docs/assets/horizoncode-hero.svg" alt="HorizonCode" width="100%" />
</p>

<p align="center">
  <strong>A coding agent for the terminal—with a fast everyday lane and a durable, evidence-led lane for bigger work.</strong>
</p>

<p align="center">
  <a href="https://github.com/sarv-projects/horizoncode">Source</a> ·
  <a href="arch_V1/README.md">Architecture</a> ·
  <a href="arch_V1/46-V1-FEATURE-INVENTORY.md">Feature map</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

HorizonCode is a Linux/WSL-first coding agent designed to keep you close to the work. Pair with a model in a direct session, or move a larger objective into a managed run with explicit tasks and independent verification. Choose the provider and model; HorizonCode should not silently choose another one for you.

## Two ways to work

| Direct session | Managed run |
| --- | --- |
| Start in your repository and work conversationally. Explore code, make changes, run checks, and keep the familiar terminal loop. | Turn a reviewed goal into bounded tasks, track durable progress, and require evidence before work is considered complete. |
| Lightweight by design. No Goal or orchestration ceremony for ordinary pair programming. | Opt in when the work benefits from explicit scope, checkpoints, recovery, and a Rust-owned task lifecycle. |

Both lanes share the same principle: the interface can ask, but only the guarded execution path can authorize a mutation.

## Built around trustworthy work

- **Your model, your call.** Keep the selected provider, model, and harness visible; no hidden model switch or paid fallback.
- **One path for changes.** File edits, commands, and other mutation-capable actions are intended to pass through a common Guard and ExecutionHost, with scoped authorization and receipts.
- **Universal mediation, earned path by path.** Universal mediation is the design goal; only individually accepted execution paths should be enabled. HorizonCode is not a fully sandboxed, cross-platform release, and platform guarantees are stated only where tested.
- **Progress you can inspect.** Managed work is organized around goals, tasks, attempts, and evidence—not a model saying “done.”
- **Uncertainty stays visible.** If an effect may have happened but cannot yet be confirmed, it is reconciled before dependent work continues; it is not blindly replayed.
- **A terminal-first workflow.** Keep the conversation central, with discoverable commands, settings, and opt-in overlays rather than a permanently crowded workspace.

## A coding toolkit, not just a chat loop

The V1 direction brings common engineering work into one coherent terminal workflow:

- **Understand the repository:** bounded file and symbol navigation, revision-aware references, and context selected for the current task.
- **Make and check changes:** guarded file operations, configured command profiles, and test/build workflows that keep results connected to the work.
- **Bring your tools:** provider and model selection, skills, MCP clients, and language/debugging integrations through their owning, permission-aware paths.
- **Keep long work legible:** streaming activity, artifacts, analytics, context controls, and durable managed-run history.
- **Choose the right level of structure:** direct pair programming for the everyday loop; managed goals and task workflows when traceability matters.

These are the intended V1 product areas; each capability is exposed only where its implementation and platform acceptance support it. Web/desktop interfaces, browser automation, and desktop control are outside the Linux/WSL-first V1 surface.

## Where HorizonCode fits

Coding agents make different tradeoffs. HorizonCode’s intended niche is the combination of a familiar direct coding loop with an optional managed lane whose authorization and completion evidence have explicit owners.

| If you value… | A useful point of comparison | HorizonCode’s direction |
| --- | --- | --- |
| A flexible, terminal-native agent and broad integrations | [OpenCode](https://github.com/anomalyco/opencode) | Build on the OpenCode-derived session and tooling substrate, while keeping HorizonCode’s managed control and effect authorization in their own Rust-owned boundary. |
| A local coding agent with an interactive terminal workflow | [Codex CLI](https://github.com/openai/codex) | Keep direct coding close at hand, and add an explicit managed-work path for durable task state and independent verification. |
| Pair programming through focused edits and a Git-aware loop | [Aider](https://github.com/Aider-AI/aider) | Preserve the quick conversational loop while making guarded effects, receipts, and uncertainty handling part of the product model. |

This is a product-shape comparison, not a benchmark or a claim that HorizonCode is better. Results depend on the selected model, task, permissions, and environment; any performance or coding-quality comparison should use matched conditions and published evidence.

## Start with the terminal

The CLI names `horizoncode` and `hzcode` are intended to launch the same entrypoint and runtime. The V1 target is Linux and WSL; platform-specific execution support is surfaced only after its acceptance requirements pass.

For contributors building from source:

```bash
git clone https://github.com/sarv-projects/horizoncode.git
cd horizoncode
python3 scripts/architecture/bootstrap_source.py --apply
bun install --frozen-lockfile
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor
bun run dev
```

The project’s full local validation command is:

```bash
bun run horizon:full-gate
```

## Explore the project

- [Architecture and ownership](arch_V1/README.md)
- [V1 feature inventory](arch_V1/46-V1-FEATURE-INVENTORY.md)
- [V1 scope and implementation tracker](implementationtov1release.md)
- [Operative implementation plan](docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md)
- [Contributor guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Documentation index](docs/README.md)

## Acknowledgements

HorizonCode builds on the OpenCode source base and relies on other open-source projects. Their authorship, licenses, and notices remain with their respective projects. HorizonCode’s first-party license and third-party notice status are documented in [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
