# CURRENT_RUN — agentX

## Active Goal
Build **agentX**: a standalone, ACP-native, Rust coding CLI agent that is protocol-first (usable by editors *and* able to drive other ACP agents), model-agnostic, local-first, and built for long-horizon work. The full capability set is in scope; nothing is to be cut. Quality and verified-working behaviour are the priority.

## Repository
- Root: `/home/sarvesh/business_Dev/agentx` (its own git repo).
- `ARCH/00`–`ARCH/21` (minus reserved `17`) + `README.md` + `TODO.md` are committed.
- `archives/` holds the frozen concept-reference docs (gitignored) — reference only.
- Donor clones for evidence: `/home/sarvesh/business_Dev/REPO-COMPARE/clone2/` (read-only reference).

## Where We Stopped
- Architecture set authored and committed:
  - `a6faf8c` — initialize agentX architecture set.
  - `38a9e35` — add analytics/discovery modules + protocol/memory requirements.
- **In flight (background, not yet reconciled):**
  - `gen-5` — precision corrections to `ARCH/` + `TODO.md` (quality/legal/correctness; explicitly **no capability cuts**).
  - `gen-6` — **P0 Rust vertical slice** (workspace + session log + one provider + read-only tools + minimal loop + ACP stdio server + headless `-p` + tests). Owns code paths only; does not touch docs or run git.
- Toolchain verified on this machine: `cargo`/`rustc` **1.98.0**, `bwrap` (`/usr/bin/bwrap`), `node` v22.23.1 + `pnpm`, `gcc`, `pkg-config`; ~836 G free.

## Next Exact Steps
1. Reconcile `gen-5`: confirm the corrections landed (see Decisions) and that IDs stayed stable; commit docs.
2. Reconcile `gen-6`: inspect the workspace, then run `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`; run the end-to-end headless test against the mock provider; commit code.
3. Then continue the TODO build order, keeping every capability.

## Decisions & Gotchas (do not undo)
- **Hybrid sourcing** (DEC-001): own the control plane; vendor narrow permissive leaves; copy **patterns only** from copyleft/source-available/`enterprise/`/unlicensed code.
- **Rust monolith, single binary** (DEC-002); TypeScript only as an *edge* SDK over stdio — never a second runtime in the core.
- **ACP is first-class in BOTH directions** (DEC-019): agentX must be usable *by* clients **and** act as an ACP client to drive other agents.
- **Sandbox**: Linux/macOS are the **first enforcement targets** (namespaces + Landlock + seccomp; Seatbelt). Windows remains a **fully supported tier** (AppContainer + restricted token) with its own acceptance tests — do not remove it.
- **Extensions are deny-by-default** with provenance pinning (DEC-018); no blind auto-install; marketplace = distribution, not trust.
- **Analytics are local-first** (DEC-017), no egress by default; engineering analytics kept distinct from product telemetry.
- **Compression** (DEC-013..016): adopt the *pattern* of observation/tool-output compression natively (not the third-party tool), make **prompt caching first-class**, use extractive compression for code / schema-bound abstractive for prose, and gate compaction on **paired per-task evals** — never on internal counters.
- **Eval harness must precede the features it gates** (DEC-016).
- **Audit** must be honest: hash-chained append-only log **plus** a signed/off-box anchor and a coverage census; never over-claim.
- **Attribution**: vendored/adapted code needs in-tree provenance; a `THIRD-PARTY-NOTICES.md` ships with the binary. Mandatory license notices are exempt from the "no upstream identity" rule (DEC-011).
- **Brand-neutral everywhere** — no competitor product names or AI-vendor/assistant/tool names in commits, docs, code, comments, or help text.
- **Never cut capability; never raise scope/timeline as an objection.** Build the full set and verify by real, repeated testing.
