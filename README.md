<div align="center">

# HorizonCode

### Don't just write the code. Finish the work.

**A terminal-first coding agent for the work that doesn't fit in one prompt.**

Explore a repository. Make a change. Check the result. And, as managed execution develops, keep larger jobs moving without losing the plan, the evidence, or control of your machine.

[Get started](#get-started) · [Why HorizonCode](#why-horizoncode) · [What's ready](#where-things-stand) · [Contribute](#built-for-contributors)

</div>

---

## Your next change is only the beginning.

Writing a patch is the easy part. The difficult part is understanding the repository, making the right change, keeping track of what happened, and knowing whether the result actually works.

HorizonCode is being built around that entire job.

- **Start immediately.** Work in an interactive coding session without creating a project plan just to fix a bug.
- **Keep your choices.** Choose the provider, model, and workflow you want; the agent should not silently substitute another.
- **See the evidence.** Tool results, tests, and repository state matter more than an agent saying “done.”
- **Go beyond one session.** The developing managed-work system is designed to preserve goals, task progress, recovery state, and final acceptance criteria across interruptions.

**One product. Two scales of work.**

## Two ways to work

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Direct coding</h3>
      <p><strong>For the change in front of you.</strong></p>
      <p>Open a repository and get moving: explore code, investigate errors, discuss approaches, and make focused edits through the interactive coding interface.</p>
      <p>No mandatory Goal, scheduler, or ceremony.</p>
      <p><strong>Available in the development build.</strong> Effectful tools are still being brought under HorizonCode's execution controls.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Managed work</h3>
      <p><strong>For the job that takes more than one turn.</strong></p>
      <p>The intended flow is a reviewed goal and specification, a durable run, explicit tasks and attempts, supervised execution, recovery, and evidence-backed verification.</p>
      <p><strong>Under active development.</strong> Durable Rust control-state foundations exist, but the managed scheduler, workers, and independent verifier are not ready for general use.</p>
    </td>
  </tr>
</table>

## Why HorizonCode

### Stay in charge of the agent

A coding assistant shouldn't surprise you with a different model, an unexpected external action, or a vague claim of success. HorizonCode's design puts model choice, execution authority, and observable outcomes in separate, explicit places.

### Build with context, not just conversation

Real changes cross files, tests, tools, and sometimes sessions. HorizonCode is growing toward a workflow where the plan, attempts, decisions, and evidence can outlive any single model response.

### One boundary for actions

Tools and extensions shouldn't become alternative ways around the user's permissions. A Rust Guard and effect-execution layer is being integrated to mediate actions before they reach the machine. The current implementation covers a narrow, tested set of effects; **universal mutation coverage is not yet complete**.

### Use the tools you actually want

The interactive foundation carries a multi-provider coding workflow and extensibility surfaces. HorizonCode is designed to keep that flexibility while adding stronger execution accounting and longer-running work—not replace it with a closed, single-model experience.

## Get started

HorizonCode is currently **source-first developer software**, not a finished downloadable CLI release. The repository contains the application workspace, a pinned source base, and HorizonCode's own Rust kernel and integration changes.

### Run the development build

On **Linux**, with Git, Python 3, [Bun 1.3.14](https://bun.sh/), and a current [Rust toolchain](https://rustup.rs/) installed:

```bash
git clone https://github.com/sarv-projects/horizoncode.git
cd horizoncode

# Restore source files not duplicated in the tracked working overlays.
python3 scripts/architecture/bootstrap_source.py --apply

# Install the pinned workspace dependencies and build the supervisor.
bun install --frozen-lockfile
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor

# Launch the development CLI.
bun run dev
```

The development CLI still carries some inherited package/command naming while HorizonCode's own release packaging is being prepared.

> [!IMPORTANT]
> **Developer preview, not a production security boundary.** Supported Guard actions and platform guarantees are still being completed. Linux is the current primary validation target; do not assume Windows/macOS isolation or all plugin, shell, MCP, and subagent paths are fully mediated yet.

### Validate the workspace

```bash
# Architecture/source checks, Rust supervisor tests, and workspace typechecks.
bun run horizon:full-gate
```

The GitHub Actions workflow also runs this gate. A green CI check proves the tested slice; it does not imply every planned capability or platform is release-ready.

## Where things stand

HorizonCode is being developed in the open. Here's the useful distinction between what is present and what's still ahead.

| In the development tree | Being built and verified |
| --- | --- |
| Interactive coding sessions and model/provider workflows | Durable managed jobs connected to real workers |
| Terminal UI and existing web/desktop foundations | A cohesive HorizonCode-branded release experience |
| Bounded provider ToolBatch validation and cancellation | Guard coverage for every enabled mutation origin |
| A Rust-supervised effect path for supported file writes | Broader sandboxed process, plugin, MCP, and browser execution |
| Durable Goal / SpecVersion / Run / Task / Attempt state foundations | End-to-end crash recovery and independently verified completion |
| Optional and Experimental feature surfaces | More fully wired feature eligibility, settings, and runtime parity |

**No fabricated benchmarks, placeholder download links, or “fully autonomous” claims:** new capabilities move into the ready column when their real execution paths and regression tests justify it.

See [HANDOFF.md](HANDOFF.md) for current implementation evidence and outstanding blockers.

## Built for contributors

This repository is a working engineering project, not just a concept page.

| Start here | What you'll find |
| --- | --- |
| [AGENTS.md](AGENTS.md) | How to inspect, implement, test, and hand off changes |
| [Architecture index](arch_V1/README.md) | The small set of current architecture authorities |
| [Implementation plan](docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md) | The dependency-ordered roadmap and acceptance work |
| [HANDOFF.md](HANDOFF.md) | What is actually implemented, tested, and still blocked |
| [GitHub Issues](https://github.com/sarv-projects/horizoncode/issues) | Bugs, discussion, and concrete work to pick up |

Before opening a substantial change, check the implementation plan and current handoff. The [source hydration script](scripts/architecture/bootstrap_source.py) deliberately preserves first-party changes instead of overwriting them with the pinned source snapshot.

## Credits and licensing

HorizonCode is an independent project by [sarv-projects](https://github.com/sarv-projects). Its interactive codebase builds on [OpenCode](https://github.com/anomalyco/opencode); the preserved source and MIT copyright notice are in [`opencode/`](opencode/) and [`opencode/LICENSE`](opencode/LICENSE). HorizonCode is not affiliated with the OpenCode maintainers.

The project is still completing root-level licensing, third-party notices, and release packaging. Existing upstream license and attribution obligations remain applicable.

---

<div align="center">

**Short task or long job: the code is only part of the result.**

[Explore the code](https://github.com/sarv-projects/horizoncode) · [See what's next](docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md)

</div>
