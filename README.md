<p align="center">
  <img src="docs/assets/horizoncode-hero.svg" alt="HorizonCode" width="100%" />
</p>

<h1 align="center">HorizonCode</h1>

<p align="center">
  <strong>A coding agent that lives in your terminal and proves its work.</strong><br/>
  Every change goes through one guarded path: a one-use lease, a real effect, a receipt you can check.
</p>

<p align="center">
  <a href="https://github.com/sarv-projects/horizoncode"><img alt="License" src="https://img.shields.io/badge/license-MIT-7c5cff"></a>
  <img alt="Rust kernel" src="https://img.shields.io/badge/kernel-Rust-e43716">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-TypeScript%20%2B%20Bun-3178c6">
  <img alt="Model" src="https://img.shields.io/badge/model-NVIDIA%20Nemotron-76b900">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20WSL2-37d6b0">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-it-actually-does">Evidence</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#models">Models</a> ·
  <a href="#feedback">Feedback</a>
</p>

<p align="center">
  <img src="docs/assets/terminal.svg" alt="HorizonCode running in a terminal" width="100%" />
</p>

<p align="center">
  <a href="https://youtu.be/REPLACE_WITH_DEMO_VIDEO">
    <img alt="Watch the 3-minute demo" src="https://img.shields.io/badge/%E2%96%B6%20watch-3--minute%20demo-ff0033?style=for-the-badge">
  </a>
</p>

<p align="center">
  <sub><em>Demo video: <code>https://youtu.be/REPLACE_WITH_DEMO_VIDEO</code> — replace before publishing.</em></sub>
</p>

---

## Why it is different

Most agents ask you to trust the transcript. HorizonCode makes the transcript
secondary: a mutation either has a receipt from the kernel or it did not happen.

|  | |
| --- | --- |
| **One authorised path** | Shell, file writes, patches and web lookups all cross the same Rust authority. The interface may *ask* for a change; only the guarded execution path can *authorise* one. |
| **Receipts, not claims** | Every effect settles with a durable record: what was targeted, what changed, which lease authorised it. A tool call that produced no receipt is a call that did nothing. |
| **Crash-safe by construction** | Goals, runs, tasks and attempts live in the kernel's own journal, fsynced, with an explicit `UNKNOWN` state for anything that cannot be settled — a crash cannot be mistaken for success. |
| **Bring your own model** | Provider and model come from [models.dev](https://models.dev). HorizonCode never silently substitutes a different one. |
| **Terminal-first** | A real TUI with modes, slash commands and approvals — no browser, no account, no telemetry. |
| **Fail fast, not forever** | Budget and no-progress guards stop the loop after a few failed attempts on the same problem instead of quietly spending your tokens. |

## Quickstart

Requires **Linux or WSL2**, [Bun](https://bun.sh) and a Rust toolchain.

```bash
git clone https://github.com/sarv-projects/horizoncode.git
cd horizoncode
python3 scripts/architecture/bootstrap_source.py --apply
bun install --frozen-lockfile
cargo build --locked --manifest-path kernel/Cargo.toml
bun run dev            # starts the TUI
```

Then tell it what you want:

```text
hzcode
> implement the invoicing API described in TASK.md, then verify it
```

Three modes, chosen explicitly and enforced by the kernel, not by prompting:

| mode | what it does |
| --- | --- |
| **Allow (yolo)** | `danger-full-access` · `approvalPolicy=never` — never asks, for sandboxed or disposable work |
| **Ask (guardrails)** | `workspace-write` · `on-request` — every effect outside the workspace asks first |
| **Deny (read-only)** | refuses every mutation, keeps exploration and search |

```bash
hzcode --yolo          # allow
hzcode                 # ask
hzcode --help          # 60 lines of real usage, on stdout
```

## What it actually does

Measured on this machine, on the NVIDIA Nemotron model, not estimated:

| task given to the agent | result |
| --- | --- |
| Build a metering/billing HTTP service from a written brief | **2,428 lines**, 33 self-written tests, and **20/20** held-back acceptance tests written by someone else — in 29 minutes, unattended |
| Write a Python package from a one-paragraph spec | completed in ~2 minutes: suite green, **0 failed tool calls** |
| Write a JSONL audit CLI from a spec, drove it through the **TUI** | **22/22** independent checks, including a working terminal UI |
| Find and fix real bugs in an unfamiliar repo | 5 of 6 tasks with every target test fixed, no regressions |
| Look things up instead of guessing | opened and cited 6 external specs (RFC 9457, RFC 6750, Stripe signatures, IETF RateLimit, ISO 4217) — every quote verified present on the page |

The agent does not grade itself: those numbers come from harnesses that run its
deliverable as a subprocess and check the exit codes.

## How it works

```
      you ──▶ TUI ──▶ session ──▶ tool batch ──┐
                                              │
                                    ┌─────────▼──────────┐
                                    │   Rust authority   │  admission · leases
                                    │  (the only writer) │  effects · receipts
                                    └─────────┬──────────┘
                                              │
                        shell · files · patch · web search
```

- **Kernel (Rust).** Owns goals, runs, tasks, attempts, guard admission, effects,
  leases and receipts, with an fsynced owner log.
- **Runtime (TypeScript/Bun).** The TUI, the model loop, tool definitions and the
  session spine. It can request effects; it cannot perform mutations itself.
- **Adapters.** Providers come from models.dev; MCP servers, skills and slash
  commands plug in without a second execution path.

## Models

HorizonCode is model-agnostic and ships no default vendor. This build was
developed and measured against **NVIDIA Nemotron** (`nvidia/nemotron-3.5-super-vl-120b-a12b`)
through [Nebius Token Factory](https://nebius.com) / NVIDIA's OpenAI-compatible
endpoint, resolved through models.dev:

```bash
export NVIDIA_API_KEY=nvapi-...
hzcode --model nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b
```

Any provider in models.dev works the same way — OpenRouter, Anthropic, OpenAI,
or a local server.

## Feedback

Built for the **Nebius × NVIDIA Global AI Hackathon** (Coding & Agentic
Engineering track). What we would tell the organisers and the tooling teams:

- **NVIDIA Nemotron on Token Factory was the most reliable part of the stack.**
  Long, tool-call-heavy turns held up; the only issue was the catalog's published
  output limit being far below what the endpoint accepts, which we had to patch
  locally to stop reasoning from starving the answer.
- **models.dev as the provider authority** removed an entire class of "which
  model am I actually talking to" bugs. More agents should do this.
- **What we would ask for next:** per-model capability metadata that is honest
  about output limits and tool-call support, so an agent can plan around a small
  context instead of discovering it mid-build.

Hackathon-relevant notes: MIT licensed, NVIDIA open model, no paid dependency at
runtime, all measurements reproducible from `reports/`.

## Known limits

We would rather list them than have you find them:

- The independent-evidence gate is designed and Rust-owned, but **not yet wired
  into the direct session lane** — a direct turn's "done" is still a claim.
- Subagent delegation is implemented but currently **disabled** behind a flag.
- Two edits to the same file in one message are refused by the kernel; the tool
  description tells the model to split them.
- Native Windows is not supported. WSL2 only.
- A handful of slash commands need a mediated shell and return 503 until that
  path lands.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture decisions live in
[`arch_V1/`](arch_V1/README.md); the current implementation state is in
[`HANDOFF.md`](HANDOFF.md).

## License

MIT — see [LICENSE](LICENSE).
