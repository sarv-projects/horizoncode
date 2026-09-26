# CURRENT_RUN — agentX

## Active Goal

Build **agentX**: a standalone, ACP-native, Rust coding CLI agent that is
protocol-first (usable by editors *and* able to drive other ACP agents),
model-agnostic, local-first, and built for long-horizon work. The full capability set
is in scope; nothing is to be cut. Quality and verified-working behaviour are the
priority.

## Repository

- Root: `/home/sarvesh/business_Dev/agentx` (its own git repo).
- `ARCH/00`–`ARCH/23` (minus reserved `17`) + `README.md` + `TODO.md` are committed.
- `archives/` holds frozen concept-reference docs (gitignored) — reference only, never
  an authority.
- Donor clones for evidence: `/home/sarvesh/business_Dev/REPO-COMPARE/clone2/`
  (read-only reference).
- Toolchain verified on this host: `cargo`/`rustc` **1.98.0**, `bwrap`
  (`/usr/bin/bwrap`), `node` v22.23.1 + `pnpm`, `gcc`, `pkg-config`; ~836 G free.
  **Landlock and seccomp are not installed here** — this constrains what the Linux
  sandbox can actually prove.

## What Is Built and Verified

Committed at `aee1e0b` (HEAD). **9 crates**, ~19k added lines.

| Area | Crate | State |
|---|---|---|
| Types/cancel/ids | `agentx-types` | done |
| Session log | `agentx-session` | done — append-only JSONL, replay, resume, deterministic interrupted-turn repair |
| Provider | `agentx-provider` | one chat-completions-compatible transport; SSE framing, retry + `Retry-After`, redaction, `SecretString`, mock transport |
| Tools | `agentx-tools` | read, glob, grep, list, write, edit, apply-patch, bash, todo, question; bounded output, guard gate, permission-filtered materialization |
| Runner | `agentx-runner` | bounded step loop, last-step tool disabling, token ceiling that fails closed, cancel → `interrupted` |
| ACP | `agentx-acp` | **server** only: stdio, `initialize`, session lifecycle, streamed `session/update`, `session/request_permission` |
| CLI | `agentx-cli` | headless `-p` (default + json/ndjson), `acp` server, documented exit-code table |
| Guard | `agentx-guard` | ordered rules, fail-closed, outer-deny ceiling, plan mode, catastrophic gate, tickets, approvals, saved rules, config layers |
| Sandbox | `agentx-sandbox` | Linux `bwrap` namespace backend, macOS Seatbelt backend, Windows AppContainer/restricted-token backend, unsupported backend, profile resolution |

**Test count: 129** `#[test]` / `#[tokio::test]` functions in the committed tree
(84 `#[test]` + 36 `#[tokio::test]` + 9 `#[tokio::test(flavor = "multi_thread", …)]`).

**How that number was verified, precisely:** by a *static* count over the committed
sources — `git ls-files 'crates/**/*.rs'` piped to an attribute grep — not by a test
run performed by the documentation lane. The pass/fail verdict for these tests was
produced by the implementation lane that authored them; the documentation lane did not
re-run them. Treat 129 as "the suite has 129 named test functions", not as "129 passed".

**What is *not* verified, and must not be described as verified:**

- No `ACC-P1-*` acceptance record exists, so **nothing is accepted**. Per
  `REQ-VER-015`, a mock, a unit result, or a browser/preview result is not acceptance
  evidence. Release gates `G-1`, `G-3`, `G-4`, `G-5`, `G-9`, `G-10` cannot be evaluated.
- No CI configuration and no license-allowlist gate exist, so `REQ-SEC-001` is
  unenforced and `G-1`/`G-9` are open.
- The 5×/20× repeat and quarantine policy (`REQ-VER-004`, `G-3`) has no retained
  evidence.
- Linux sandbox enforcement is **namespace isolation** only. Landlock and seccomp are
  **not installed on this host**, so namespace isolation is the actual enforcement and
  **must never be described as equivalent to syscall-level denial**.
- The macOS and Windows backends **compile but are untested on this host**.

## In Flight

- **Code lane:** active on `crates/`, `Cargo.toml`, `Cargo.lock`. It owns an update to
  the `session_store()` writability probe and an update to `Guard::policy_hash` (see
  Open defects 1 and 2 in `TODO.md`).
- **Docs lane (just completed):** per-tier network qualification — `REQ-VER-005`,
  `REQ-SEC-016`, `REQ-SEC-008`, `AX-102`, `AX-119` reworded to `DEC-026`, plus the new
  `DEC-027` read-through; `TODO.md` re-based on `git log` evidence with a new
  **Open defects** section; `README.md` status corrected; this handover.

## Next Exact Steps

1. **Land the audit component (`AX-104`).** It is the single largest gap and the P1
   differentiator is "guard + **verifiable audit**" — the guard half ships, the audit
   half does not exist. Hash chain + dense `seq` + periodic Merkle roots + an
   `audit verify` command + redaction, per `ARCH/14` and `REQ-AUDIT-001..003`.
2. **Finish the two in-flight fixes** (session-store writability probe, `policy_hash` →
   a cryptographic digest) and land a regression test for each; `REQ-VER-017` says a fix
   without a regression test is not complete.
3. **Build the verification harness (`AX-122`)** before claiming anything: injectable
   clock/rng/home, a loopback-only HTTP wrapper with a non-loopback tripwire, the 5×/20×
   repeat run, and the quarantine ledger.
4. **Then run the acceptance matrix (`AX-123`)** `ACC-P1-01..08` and retain the records
   under `<state-dir>/evidence/<build-id>/`. Until then every readiness claim stays
   `implemented`.
5. **Commit the P1 decision table (`ACC-P1-02`)** and a static gate that no path
   decision is produced outside the guard (`DEC-025`, `REQ-SEC-025`).
6. **Finish `AX-115`/`AX-118`:** the `external_directory` floor rule, bash
   argument-path extraction into guard `fs.*` resources (today `resources_from_input`
   still pushes the raw `command` string), canonicalize-and-re-validate at use, and the
   guard↔sandbox pattern parity corpus.
7. **Reconcile the catalog wording** (`TODO.md` Open defect 7): `ARCH/05`'s hard-gate
   bullet against `DEC-021`, which already closed it.
8. Then continue the tracker order, keeping every capability.

## Decisions & Gotchas (do not undo)

- **Hybrid sourcing** (`DEC-001`): own the control plane (loop, guard, audit, context,
  routing, orchestration); vendor narrow permissive leaves; take **patterns only** from
  copyleft / source-available / restricted-dual-license / unlicensed code. No external
  registry's trust policy is inherited.
- **Rust monolith, single binary** (`DEC-002`); TypeScript only as an *edge* SDK over
  stdio — never a second runtime in the core.
- **ACP is first-class in BOTH directions** (`DEC-019`): usable *by* clients **and** an
  ACP client that drives peer agents. This supersedes the "later" qualifier in
  `DEC-003`. The client half is not built yet.
- **Sandbox:** Linux/macOS are the **first enforcement targets**; Windows is a **fully
  supported but separately tested** tier with its own acceptance rows — do not remove it
  and do not describe it as equivalent to the Unix path/syscall bar.
- **Per-tier network guarantee levels** (`DEC-026`, read through by `DEC-027`): every
  tier declares `enforced` | `capability` | `best_effort` | `none` with its mechanism
  and residual; the level is surfaced wherever a network-restricted profile is shown and
  recorded in that tier's acceptance record. **Linux `enforced` is the required level for
  any profile advertised as network-restricted**, and a tier that cannot meet a required
  level **refuses** — never a silent downgrade. "Network off" is the *request* a profile
  makes, never a claim about what a tier enforces.
- **Path policy is split three ways** (`DEC-025`, with `DEC-024`): the guard
  **authorizes**, the sandbox **enforces reach**, the tool plane only **extracts**
  resources and may escalate — never decide. A path named by a shell argument travels as
  an `fs.*` resource; a path-shaped `exec.run` rule is rejected at load.
- **Extensions are deny-by-default** with provenance pinning (`DEC-018`); no blind
  auto-install; a marketplace is distribution, not trust.
- **Analytics are local-first** (`DEC-017`), no egress by default; engineering analytics
  stay distinct from product telemetry.
- **Compression** (`DEC-013..016`): adopt the *pattern* of observation/tool-output
  compression natively (never the third-party tool), make **prompt caching first-class**,
  use extractive compression for code and schema-bound abstractive for prose, and gate
  compaction on **paired per-task evals** — never on internal counters.
- **The eval harness must precede the features it gates** (`DEC-016`, generalized as
  `REQ-VER-018`/`G-11`). `AX-307` is the prerequisite; it is not started.
- **Audit is honest about what anchoring proves** (`DEC-022`): roots are always signed;
  the default is `local-sink`; `off-box` is required for any deployment declaring an
  off-box trust requirement; a configured-but-unreachable sink **fails closed**;
  `local-trust` survives only as an explicit, acknowledged, labeled posture. A chain —
  even anchored — proves **detection of modification of already-anchored history**; it
  does not prove content authenticity, does not detect fabrication by a principal with
  write access, and does not cover the unanchored tail. Never over-claim it.
- **Catalog posture** (`DEC-021`): curated primary with per-row provenance, opt-in
  enrichment, offline-by-default, **no bundled full-dataset snapshot**, no third-party
  marks, attribution unconditional.
- **Attribution:** vendored/adapted code needs in-tree provenance; a
  `THIRD-PARTY-NOTICES.md` is generated at release and ships with the binary.
  License-mandated attribution is exempt from brand-neutrality (`DEC-011`).
- **Brand-neutral everywhere** — no competitor product names and no AI-vendor/assistant
  names in commits, docs, code, comments, or help text.
- **Requirement wording rule** (`ARCH/00` §Requirement quality bar): a guarantee that
  holds only on some tier, case, or configuration is written with that scope **stated in
  the requirement**; the strict form stays the floor and the weaker statement is scoped.
  A requirement is never lowered to remove a contradiction — a contradiction is resolved
  by a `DEC-*` and a scoped rewording.

## Standing Instructions

- **Never raise scope or timeline as a concern.** Do not propose cutting, deferring, or
  descoping a capability in order to hit a date. The full capability set ships.
- **Never cut a capability** to make something else fit.
- **Verify by repeated real tests.** Evidence is executable and repeated: the 5×
  consecutive clean full-suite run and ≥20 repetitions for process/platform-sensitive
  suites, with retained records. Visual confidence, a single green run, or a mock is not
  evidence.
