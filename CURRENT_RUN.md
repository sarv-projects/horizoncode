# CURRENT_RUN — HorizonCode

Updated 2026-09-28. This handoff covers the **first implementation wave** of the
durable long-horizon work. It supersedes the documentation-only audit handoff of
2026-09-27, which remains the record of what was read and why.

## Active goal

Deliver the first implementation wave that makes the session log and the audit chain
honest under inspection and crash, in dependency order, without adding a second
persistence path, permission system, or scheduler:

1. typed session enumeration that never reports a store failure as "no sessions" (`AX-353`);
2. read-only session paths that never truncate or repair a log (`AX-351`, read-only slice);
3. a commit durability profile with namespace durability and typed refusal (`AX-352`);
4. audit read/write integrity: read-only verification, access evidence outside the chain, typed head and enumeration failures, an OS-backed writer lock, explicit repair (`AX-346`, integrity slice);
5. the determinism and crash infrastructure the acceptance records require (`AX-122`, determinism/crash slice).

## Where the work stopped

Starting point: Git `53a2654`/`b677443` (docs-only, Rust unchanged since `1c7a1c6`).
The Rust source has now been changed; the exact revision is the commit this handoff
travels with.

**Contract-first edits (architecture, before code).**

- `ARCH/07-SESSION.md`: exact `SessionListResult`/`SessionListEntry`/`SessionListIssue`
  payload, integrity derivation order, and the rule that only a store-level failure
  clears `enumeration_complete`; a new *Commit durability backend* section (profiles,
  the `sync_file`→`sync_dir`→acknowledge order, refusal conditions); a dated source-status
  block for the read-only split, stating that `recover(...)` is still unimplemented.
- `ARCH/15-PROTOCOLS.md`: session-listing result/error mapping, including that a
  `session/list` is not advertised until implemented and tested, and that no surface may
  substitute "no sessions" for a failed scan.
- `ARCH/14-AUDIT.md`: dated source-status block for the access stream, typed head,
  refusal on torn tails, and the OS-backed lock, with the remaining work named.
- `ARCH/24-ARCHITECTURE-REVIEW.md`: a dated implementation-pass section, plus **F-65**
  and **F-66** (see below).
- `research docs/tests.md`: the determinism/fault-injection/kill-matrix inventory, the
  quarantine policy, and the baseline failure list with what each test proves.

**Source changes.**

- `crates/horizoncode-types/src/clock.rs` (new): the injectable `Clock` trait,
  `SystemClock`, and `system_clock()`. Production code no longer reads the host clock
  directly; the session store takes an `Arc<dyn Clock>`.
- `crates/horizoncode-testkit` (new crate, dev-only): `TestClock`, `ScriptedFaults`/
  `FaultOp`, `StoreSnapshot` (byte-level before/after proof) and the kill-point
  environment contract. It is a dev-dependency of test suites and is never linked into
  the binary. `ARCH/03`/`ARCH/07` note the non-product crate in prose.
- `crates/horizoncode-session/src/durability.rs` (new): `DurabilityProfile`, the
  `CommitSink` seam (`supports_run_durable`, `sync_file`, `sync_dir`), `StdCommitSink`,
  `UnsupportedSink`.
- `crates/horizoncode-session/src/listing.rs` (new): the typed listing contract, the
  integrity enum, the issue kinds and payload, and `SessionListResult`.
- `crates/horizoncode-session/src/store.rs`: one pure `scan_log` behind
  `read_only`/`scan`/`inspect`/`list`; `list` returns `SessionListResult`; `inspect`
  reports a present-but-unreadable log; `latest` prefers a readable session; `create`/`append`
  commit through the durability profile; the torn-tail truncation moved behind the
  documented repairing path and no longer appends a repair event.
- `crates/horizoncode-session/src/error.rs`: `HeaderMissing`, `HeaderCorrupt`, `Durability`.
- `crates/horizoncode-audit/src/access.rs` (new): the independent access-evidence stream
  with its own sequence, `blake3` chain, ownership/mode checks and OS lock, plus a
  chain-verifying reader.
- `crates/horizoncode-audit/src/store.rs`: the writer lock is taken before head/segments
  are read and held for the store's lifetime; the head is read as
  `Absent | Present | Malformed | Unreadable`; a torn tail refuses an ordinary open;
  `AuditLog::repair_segment` is the explicit, byte-preserving repair with a linked
  recovery artifact; `segment_indices` returns typed errors; the head replace syncs its
  directory entry.
- `crates/horizoncode-audit/src/error.rs`: `HeadInvalid`, `HeadMissing`, `RecoveryRequired`,
  `StoreLocked`.
- `crates/horizoncode-cli`: `audit repair --segment --output`; access recording moved to
  the access stream and is required **before** any read; new exit code `7`
  ("the audit access record could not be written, so nothing was disclosed"), documented in
  `--help` and asserted against it.
- `Cargo.toml`: `rust-version` 1.88 → 1.89, because the OS-backed lock uses
  `std::fs::File::try_lock` and no process-lock dependency was added.

**Tests added or changed.**

- `horizoncode-session/tests/list.rs` (8), `tests/read_only.rs` (8),
  `tests/kill_matrix.rs` (1 test, 20 cycles × 5 crash points, real child processes).
- `horizoncode-audit/tests/integrity.rs` (10), `tests/writer_race.rs` (1 test, 20
  two-process cycles).
- Three existing tests were changed because they asserted the behaviour this pass removed:
  an audit census test that held two writers open at once; a census test that counted a
  read as chain coverage; and an exit-code test whose negative control relied on `verify`
  creating the store it reads.

## Checks run, at this revision

- `cargo fmt` for every file this pass wrote or changed: clean
  (`cargo fmt -p horizoncode-session -p horizoncode-audit -p horizoncode-cli -p
  horizoncode-types -p horizoncode-testkit`). The **workspace as a whole is not
  rustfmt-clean at the baseline**: `cargo fmt --all --check` reports 67 pre-existing
  diffs, including two inside crates this pass touched
  (`horizoncode-audit/src/redact.rs`, `horizoncode-cli/src/approval.rs`). Those
  reformats were deliberately reverted rather than bundled into this wave, so
  `cargo fmt --all --check` is a pre-existing failure here and must not be reported as
  a pass. Formatting the rest of the tree is its own cleanup task.
- `cargo clippy --workspace --all-targets -- -D warnings` — pass.
- `cargo test --workspace --no-fail-fast` — 4 failing tests, all four failing identically
  at baseline `b677443`:
  - `horizoncode-audit` `entry::tests::genesis_matches_its_label`, `anchor::tests::genesis_root_matches_its_label` (**F-65**);
  - `horizoncode-cli` `e2e_acp::acp_initializes_creates_a_session_and_streams_updates`, `e2e_tools::headless_write_edit_and_sandboxed_bash` (**F-66**).
- Baseline comparison was performed in a clean worktree at `b677443`; no test that passed
  there fails here.
- One unreproduced flake was observed once and not in 11 subsequent runs:
  `horizoncode-audit` `chain::a_recomputed_merkle_root_matches_the_signed_root_and_a_tampered_root_fails`.
  It is reported rather than dismissed, because a flake re-opens the requirement it covers
  (`ARCH/23`).

## Known limitations of this pass

- `ACC-P1-12` is satisfied only in its read-only and enumeration halves. Explicit
  recovery (`AX-311`) and the index rebuild (`AX-350`) are still missing, so a torn tail is
  retained and reported rather than reconciled.
- `ACC-P1-13` is satisfied at the ordering and refusal level only. Real ENOSPC and power
  loss need an isolated fixture and explicit authorization; they are `insufficient
  evidence`, not passes. The advisory lock is per-host-filesystem and does not claim
  anything about NFS.
- `ACC-P1-04` is satisfied for read-command non-mutation, typed read failures, access
  receipts and writer locking. The global `audit_seq`/`segment_seq` migration, per-effect
  prepare/terminal reconciliation, device-key rotation and the tamper matrix remain
  `AX-346` remainder / `AX-311`.
- `run_durable` currently promises namespace durability of the **event log** only: no
  segmentation, no committed head file, and no physical control/recovery reserve yet.
- Fuzz targets, corpora and seeded-RNG coverage of provider retry jitter (`AX-122`
  remainder) are untouched.

## Decisions and gotchas

- `std::fs::File::try_lock` is the OS-backed lock, which is why the workspace MSRV moved to
  1.89 and why no new dependency (and no license-gate entry) was needed. `flock`-style
  advisory locks do not help across NFS; records must name the filesystem they were proven on.
- Holding the audit writer lock for the store's lifetime changes the contract for callers:
  two `AuditLog::open` calls on one store in one process are now a typed `StoreLocked`
  refusal, not a silently tolerated second writer.
- The access ledger holds its lock for the ledger's lifetime too, so a test that wants to
  read receipts while the CLI still runs must use `read_receipts(path)` (no lock) instead of
  opening an `AccessLedger`.
- `record_access` runs *before* every read, so an unwritable access stream makes `verify`,
  `replay` and `census` exit `7` with no output. That is deliberate: disclosure without a
  durable record of disclosure is the outcome the access ledger exists to prevent.
- The session `load()` path still repairs (truncates) a torn tail. It is now documented as
  the repairing path and is not reachable from any read-only surface, but it is **not** the
  `recover(session_id, expected_head, recovery_id)` the architecture specifies; that
  operation remains `AX-311`.
- `latest()` returns the newest **readable** session, so `--continue` no longer silently
  resumes a corrupt session.

## Next exact steps

0. Decide whether to format the rest of the tree in its own change, so the documented
   `cargo fmt --all --check` baseline becomes enforceable (`AX-121` builds the gate that
   would catch this).
1. Commit this wave (see the commit list below) with `TODO.md` and this handoff included.
2. `AX-355` (F-66) before any further tool-plane work: find why a read-only `list` call is
   denied and why an allow and a deny are both recorded for it in one turn. Fix at the
   owning layer (guard rules or tool permission derivation), keep the deny-elevation rule,
   and re-run the two failing e2e tests.
3. `AX-354` (F-65): decide whether the genesis label or the pinned constant is
   authoritative, record the migration consequence, and keep the assertion.
4. `AX-350` session half: bounded digest-linked segments, committed head, streaming replay,
   event-byte quota and the protected control reserve — now unblocked by `AX-352` and the
   stable read-only contract. The run-log half still waits for `AX-309`/`AX-312`.
5. `AX-311`: the effect journal, which unblocks `AX-351`'s recovery half and gives
   `ACC-P1-06`/`ACC-P1-12` their recovery evidence.
6. Then `AX-309` and the controller chain (`AX-301`, `AX-310`, `AX-312`, `AX-313`,
   `AX-317`, `AX-337`, `AX-347`) before any multi-hour claim.

## Unresolved questions

- Which side of F-65 is authoritative: the label or the pinned constant (and what a
  migration of existing chains costs).
- Whether F-66 is a missing default-allow rule, a resource-pattern mismatch, or a
  double evaluation of the same call; not yet isolated.
- Whether the segment/head format (`AX-350`) needs a format version bump for the durability
  backend, given that no head file exists yet.

## Commits in this wave

One commit per coherent unit; the session and audit changes each touch a single
large file, so they are not split further for the sake of a commit boundary.

1. `docs: specify typed session enumeration, durability profile, and read-only boundary`
2. `feat(harness): add an injectable clock and a test-support crate`
3. `feat(session): add typed enumeration, byte-preserving reads, and a durability profile`
4. `fix(audit): record access outside the chain and refuse unverifiable store state`
5. `feat(cli): add the audit repair surface and the access-record exit code`
6. `docs: record the implementation pass, the measured findings, and the handoff`

Each commit is self-contained and builds; commit 2 carries the workspace manifest,
so its body notes the MSRV move that commit 4's OS-backed lock depends on.

## Worktree preservation

The user-owned untracked `uipics/` and `.code-intelligence/` are preserved and were not
staged. No remote was touched, nothing was pushed, published, or deployed, and no
production data was changed. Two temporary baseline worktrees were created under
`/tmp/opencode` for the failure comparison and were removed.
