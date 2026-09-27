# CURRENT_RUN — HorizonCode

> **2026-09-27 update.** The five core research notes were read end to end and
> crosswalked in `ARCH/26-CORE-AGENT-CROSSWALK.md`. The architecture now includes
> the integrated long-horizon controller (`ARCH/25`), 29 findings
> (`ARCH/24`), and follow-up tasks `AX-309..333`. Product identity was renamed
> from agentX to HorizonCode, including Rust crate directories/names, binary,
> CLI/environment labels, default state/config paths, and active documentation;
> `DEC-033` records the naming and state migration boundary.
>
> Verification performed for this pass: `git diff --check`, offline Cargo
> metadata resolution, and `cargo check --offline --workspace` passed after
> crate renaming. No test suite or `ACC-P1-*` acceptance run was executed.
> These checks do not verify the proposed multi-hour controller, which remains
> unimplemented. The root checkout directory still has its old filesystem name;
> it is recorded accurately below.
>
> All non-ignored worktree changes are committed as `58569f4` on local branch
> `main`. The new GitHub repository already had an Apache-2.0 LICENSE-only
> initial commit (`e41b670`); local `main` now merges that history at
> `1c1e755`, preserving the license. `origin` uses the configured SSH alias
> and points to `sarv-projects/horizoncode`. Push is pending after this handoff
> update is committed.
>
> Read `ARCH/24` for findings, `ARCH/25` for the integrated design, and
> `ARCH/26` for the source-pattern crosswalk. The user's confirmed priority is
> **verified multi-hour completion**. Packaging and surface decisions may be
> reconsidered when evidence supports the change. Do not turn an earlier test
> result or a crate's presence into an acceptance claim.

## Active Goal

Build **HorizonCode**: a standalone, ACP-native, Rust coding CLI agent that is
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

Committed at **`f4a8afa`** (HEAD). **11 crates**, ~33k added lines.

| Area | Crate | State |
|---|---|---|
| Types/cancel/ids | `horizoncode-types` | done |
| Session log | `horizoncode-session` | done — append-only JSONL, replay, resume, deterministic interrupted-turn repair |
| Provider | `horizoncode-provider` | one chat-completions-compatible transport; SSE framing, retry + `Retry-After`, redaction, `SecretString`, mock transport |
| Tools | `horizoncode-tools` | read, glob, grep, list, write, edit, apply-patch, bash, todo, question; bounded output, guard gate, permission-filtered materialization |
| Runner | `horizoncode-runner` | bounded step loop, last-step tool disabling, token ceiling that fails closed, cancel → `interrupted` |
| ACP | `horizoncode-acp` | **server** only: stdio, `initialize`, session lifecycle, streamed `session/update`, `session/request_permission` |
| CLI | `horizoncode-cli` | headless `-p` (default + json/ndjson), `acp` server, documented exit-code table |
| Guard | `horizoncode-guard` | ordered rules, fail-closed, outer-deny ceiling, plan mode, catastrophic gate, tickets, approvals, saved rules, config layers |
| Sandbox | `horizoncode-sandbox` | Linux `bwrap` namespace backend, macOS Seatbelt backend, Windows AppContainer/restricted-token backend, unsupported backend, profile resolution |
| Audit | `horizoncode-audit` | BLAKE3 hash-chained append-only entries, canonical `BodyRef` under a domain-separated label, periodic segment Merkle roots, roots signed with a keyed MAC and sealed to `roots.jsonl`, coverage census, `verify`/`replay`, redaction before hashing |
| Analytics | `horizoncode-analytics` | local append-only ledger + SQLite rollups, `CostStatus` actual/estimated/included/unknown, `/usage`, `/insights`, `stats`, `export --sanitize` |

**Test count: 272 passing across 37 suites, 0 failures** at `f4a8afa` (baseline 129 +
143 added by the audit/analytics lane). This is an **executed verdict**, not a static
count: the implementing lane ran the full suite twice and the orchestrator independently
ran `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`
(clean), and `cargo test --workspace` **twice more** — 272 passed / 0 failed both times,
with 0 brand-name hits across `crates/`.

One flake was investigated rather than waved off: on a *cold*, I/O-starved 4-core box
the first full run lost both pre-existing `e2e_acp.rs` tests to a 20s per-read timeout.
Evidence that it is environmental, not a hang: 5/5 standalone (0.44–3.5s) and 3/3 at
load average 9; a forced 114-file rebuild took 90s wall for 22s CPU; one analytics suite
took 52.16s cold vs 0.43s warm (120× spread); `e2e_acp` then passed in 0.47s. The
timeout was deliberately **not** widened, because that would mask genuine hangs.

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

- **gen-12 — security hardening (`crates/`), the only live code lane.** It owns
  `Cargo.toml`/`Cargo.lock` and the cargo build lock, so no other code lane may start
  until it reports. Scope is the independent-review findings, S1 first:
  - **S1 (live containment gap):** the Linux/macOS sandbox scopes *writes* but not
    *reads* — `--ro-bind / /` leaves the whole host readable, `FsOp::Read` returns `Ok`,
    there is no `readable_roots` on any profile, the CLI default sets no deny globs, and
    `default_rules()` allows `exec.run **` — so a default `bash` can read `~/.ssh/id_rsa`.
    `ARCH/13` requires reads scoped to granted roots on **every** tier.
  - S2 macOS Seatbelt never applies `resolved.deny` / `resolved.protected` globs.
  - S3 symlink-parent TOCTOU on the write path; `check_sandbox_write` is a no-op when
    `ctx.resolved` is `None`.
  - S4 guard ignores `mode`/`unmatched` from the **global** config; dead
    `approval.default_timeout_ms`.
  - S5 path-shaped `exec.run` rules are accepted at load (violates `DEC-025`).
  - S6 `bash` never extracts path-shaped argv into `fs.*` resources.
  - S7 issued tickets are never validated and `allow once` issues an **unbounded** ticket.
  - P3 redaction does not cover tool args / event payloads.
  - T3 `write`/`edit` have no base-hash compare, so a concurrent change is overwritten.
  - Each item must land with a test that **fails before the fix** and passes after.
- No docs lane is live. `CURRENT_RUN.md` and `TODO.md` are the only non-crate files in
  play.

**Stale finding corrected:** an earlier report listed a `session_store()` writability-probe
order-dependence defect. Verified by grep, **no such code exists at HEAD** (no
`session_store()`, no `OnceLock` in `horizoncode-cli`, no `horizoncode-runner/src/main.rs`, no
`agent::Kind`, no `content::Text::new`). It was a phantom from a stale lane report; the
audit lane instead shipped a `TestHome` helper with order-independence regression tests.
Do not go looking for it.

## Next Exact Steps

1. **Let gen-12 land the security hardening (S1-S7 + P3 + T3).** S1 is the one that
   matters: until reads are scoped, the word *sandboxed* overstates what the code
   enforces. Verify the lane's claim that each item has a test which fails **before** the
   fix, then re-run `fmt` + `clippy -D warnings` + the full suite twice yourself before
   committing.
2. **`Guard::policy_hash` still uses `DefaultHasher`** - a non-cryptographic fingerprint
   that lands on every authorization ticket. The audit lane already depends on BLAKE3, so
   switch it to the same digest. This is the one real item from the old Open-defects list;
   see the phantom note above for the other.
3. **Build the verification harness (`AX-122`)** before claiming anything: injectable
   clock/rng/home, a loopback-only HTTP wrapper with a non-loopback tripwire, the 5×/20×
   repeat run, and the quarantine ledger.
4. **Then run the acceptance matrix (`AX-123`)** `ACC-P1-01..08` and retain the records
   under `<state-dir>/evidence/<build-id>/`. Until then every readiness claim stays
   `implemented`.
5. **Commit the P1 decision table (`ACC-P1-02`)** and a static gate that no path
   decision is produced outside the guard (`DEC-025`, `REQ-SEC-025`).
6. **Then the context engine** (`CMP-context`): token budgets, typed system-context
   sources, `AGENTS.md` discovery, the tree-sitter + PageRank repo map, and compaction
   with the anchored summary template. The eval harness from step 3 is its prerequisite
   (`DEC-016`).
7. **Then MCP host, skills, plugins, orchestrator/subagents, and the TUI cockpit** - none
   of these exist in code yet, and all of them are in scope. Do not cut them.
8. **The rename is still parked by explicit user instruction.** All evidence is at
   `/tmp/opencode/horizoncode-naming.md`; `DEC-028` is deliberately unwritten and every
   `horizoncode-*` identifier is unchanged. When the user picks, the sweep is mechanical and
   must run as a single owner lane with no other code lane live.

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

## Environment / Tooling Incident (2026-09-27) — engram MCP "Connection closed"

Not part of the HorizonCode codebase; recorded only as an operator note. The OpenCode MCP
server `engram` (`mcp.servers.engram` → `~/.local/share/mcp-servers/mneme/mneme mcp
--tools=agent,graph`, a fork of engram) intermittently reports status `failed` with
error `Connection closed`. **Root cause (reproduced):** OpenCode spawns one `mneme mcp`
process per loaded project directory; every instance runs `store.New` →
`migrate()`/`repairEnrolledProjectSyncMutations()` (a write transaction) against the
single shared `~/.engram/engram.db`. On a write-lock collision past
`PRAGMA busy_timeout=5000`, `migrate()` fails `SQLITE_BUSY` → `cmdMCP` calls
`fatal(err)` → process exits → stdio closes mid-`initialize` → the MCP SDK throws
`Connection closed`. With a held `BEGIN IMMEDIATE` on the DB, `mneme mcp` exited 1 in
~7.5s with `engram: migration: database is locked (5) (SQLITE_BUSY)` and empty stdout.
Contributing (not exit-causing): the fork runs a blocking GitHub update check on every
startup before serving MCP. **Fix:** single-instance/less-fan-out engram, or
patch/rebuild the fork to raise `busy_timeout` + retry migration and to skip the update
check for `mcp`/`serve`. Raising OpenCode's client timeout does not help (the child
exits, it does not time out).
