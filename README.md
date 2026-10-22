> **In progress.** HorizonCode V1 is not released. Implementation status: [HANDOFF.md](HANDOFF.md). Wiring checklist: [arch_V1/46-V1-WIRE-TRACKER.md](arch_V1/46-V1-WIRE-TRACKER.md).

<p align="center">
  <img src="docs/assets/horizoncode-hero.svg" alt="HorizonCode" width="100%" />
</p>

<p align="center">
  <strong>One coding agent — direct sessions and optional managed runs, under your models and Guard.</strong>
</p>

HorizonCode is a Linux/WSL-first coding agent: interactive **direct sessions** for everyday work, optional **managed runs** when you want durable goals and verification, a Rust **Guard / ExecutionHost** on every mutation, and a terminal UI built for long sessions.

## What it is

| Lane | For |
| --- | --- |
| **Direct session** | Pair programming in a repo — explore, read, patch, terminal, search — no Goal required |
| **Managed run** | Multi-step work with spec review, tasks, verifier evidence, and recovery (opt-in) |

Product rules: **no silent model swap**, **no hidden paid fallback**, **one capability registry**, mutations through **Guard → lease → receipt** (reads may use the fast path where accepted).

## Commands

Canonical CLI names (same entrypoint): **`horizoncode`** and **`hzcode`**.

## Build from source

**Prerequisites:** Linux or WSL, Git, Python 3, [Bun](https://bun.sh/), [Rust](https://rustup.rs/).

```bash
git clone https://github.com/sarv-projects/horizoncode.git
cd horizoncode
python3 scripts/architecture/bootstrap_source.py --apply
bun install --frozen-lockfile
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor
bun run dev
```

Validation gate (when dependencies are installed):

```bash
bun run horizon:full-gate
```

Official installers and signed releases are not shipped yet.

## Project status

HorizonCode is being implemented in public. **Interactive coding and the application foundation are present; the full managed-coding product is not yet released.**

| In the repository now | Still being completed for V1 |
| --- | --- |
| Direct interactive sessions and provider/model selection | Complete branded installation and release packaging |
| Rust Guard for supported approved file writes; bounded ToolBatch validation | Universal mediation of shell, process, plugin, MCP, subagent and other mutations |
| Durable internal Goal / SpecVersion / Run / Task / Attempt event state | Authenticated managed UI, production scheduler/workers, leases and effect reconciliation |

**Security note:** this is not a fully sandboxed, cross-platform production release. Specific execution paths and supported operating systems must pass their own tests before those protections can be claimed.

Implementation record: [HANDOFF.md](HANDOFF.md). Operative plan and gates: [docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md](docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md).

The private root workspace currently declares `UNLICENSED`, pending an explicit HorizonCode distribution license decision. Root-level license/third-party notices and final distribution packaging are being completed before release.

## Documentation

| Topic | Where |
| --- | --- |
| Architecture | [arch_V1/README.md](arch_V1/README.md) |
| V1 scope and phases | [implementationtov1release.md](implementationtov1release.md) |
| Built-in tools and skills | [arch_V1/46-V1-FEATURE-INVENTORY.md](arch_V1/46-V1-FEATURE-INVENTORY.md) |
| Agent / contributor policy | [AGENTS.md](AGENTS.md) |
| Docs index | [docs/README.md](docs/README.md) |
| Root file guide | [docs/repository-root-inventory.md](docs/repository-root-inventory.md) |

## Contribute

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [Issues](https://github.com/sarv-projects/horizoncode/issues)

## Credits

HorizonCode is developed by [sarv-projects](https://github.com/sarv-projects).
