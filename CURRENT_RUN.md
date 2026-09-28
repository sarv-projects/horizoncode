# CURRENT_RUN — HorizonCode

Updated 2026-09-28 (second pass, same day). This handoff covers the **first
implementation wave** plus the closure of `F-66`/`AX-355` — the permission-seam defect
the first wave's test run exposed. It supersedes the documentation-only audit handoff
of 2026-09-27, which remains the record of what was read and why.

## Active goal

Deliver the first implementation wave that makes the session log and the audit chain
honest under inspection and crash, in dependency order, without adding a second
persistence path, permission system, or scheduler:

1. typed session enumeration that never reports a store failure as "no sessions" (`AX-353`);
2. read-only session paths that never truncate or repair a log (`AX-351`, read-only slice);
3. a commit durability profile with namespace durability and typed refusal (`AX-352`);
4. audit read/write integrity: read-only verification, access evidence outside the chain, typed head and enumeration failures, an OS-backed writer lock, explicit repair (`AX-346`, integrity slice);
5. the determinism and crash infrastructure the acceptance records require (`AX-122`, determinism/crash slice);
6. the permission seam: a read-only call is not denied by its own re-assertion, and one call records exactly one policy decision (`AX-355`, closing `F-66`).
7. provider-response admission owns tool-call id uniqueness, so a malformed batch is refused
   instead of surfacing as a per-call denial (`AX-356`).
8. the pinned audit genesis constants are reconciled with the labels they claim, with the
   pre-rename derivation recorded and refused (`AX-354`, closing `F-65`).
9. the first breadth slice: one configuration crate owns the discovery walk, the shared
   JSONC reader, the typed settings merge with provenance, and hierarchical `AGENTS.md`
   discovery; one `state_root()` resolves the documented `~/.horizoncode` fallback
   (`AX-008`, fixing `F-67` as `AX-357`).
10. the shipped third-party notices bundle: generated from the pinned dependency
   graph, embedded in the binary for `--credits`, and gated so a dependency change
   cannot ship stale attribution (`AX-010`).
11. the finite storage ceilings the segmented logs and artifact store need before
   they can be coded: published as `DEC-058`, carried by the config schema with
   lower-only validation, and exposed as typed limit views (`AX-348`, decision slice).
12. the shared segmented event-log core both session and run history need: canonical
   envelope, bounded segments with seals, committed head, streaming replay, version
   refusal, and preserved uncommitted tails (`AX-358`, the `AX-309` slice 1).
13. the typed slash-command registry and composer-reference parser: strict parse with
   suggestions, registry-generated help/search/completion, no fall-through to model
   text, and literal preservation for non-references (`AX-344`).

**Breadth program (user directive, 2026-09-28).** After the wave above, the user asked to
plan, check, and build the remaining proposed rows in dependency order without stopping
between them. The order is: `AX-008` (layered config + `AGENTS.md` discovery — the
prerequisite for nearly every other row) → `AX-010` (notices/provenance bundle) →
`AX-348` (bounded content-addressed artifacts, and publishing the finite
`session.log.*`/`run.log.*` defaults) → `AX-009`/`AX-344`/`AX-343` (TUI shell, typed
slash commands and `@` references, theme/accessibility settings) → `AX-110` (skill
discovery) → `AX-106`/`AX-332` (MCP client + schema filtering) →
`AX-112`/`AX-340`/`AX-341`/`AX-342`/`AX-304` (ACP client, agent directory, profiles,
per-agent model/quota visibility, peer pools) → `AX-320`/`AX-201`/`AX-202`/`AX-319`
(revision-bound repo index, tree-sitter map, LSP, context projection) → `AX-207`
(checkpoints/rewind, needs `AX-348`) → the governance and evidence rows
(`AX-119`, `AX-120`, `AX-121`, `AX-123`, `AX-124`, `AX-126`, `AX-307`, `AX-318`,
`AX-321`, `AX-329`, `AX-336`). Reconnaissance for the plan confirmed that none of these
subsystems exist today: no TUI/LSP/tree-sitter/WASM/MCP dependency, no artifact store,
no settings module, no notices bundle. The breadth vocabulary exists only as guard
policy words (`mcp.call`, `skill.install`).

## Where the work stopped

Starting point: Git `53a2654`/`b677443` (docs-only, Rust unchanged since `1c7a1c6`).
The Rust source has now been changed; the exact revision is the commit this handoff
travels with.

**Second pass — `AX-355` / `F-66` (permission seam).**

Three separate defects produced one symptom. Root-caused by reading the call path and
reproducing each cause independently:

1. `GuardPermissionGate::pairs` (`crates/horizoncode-tools/src/guard_gate.rs`) mapped a
   request naming **no resource** to an empty pair set, while the guard normalizes such a
   request to the wildcard and scopes its ticket to `**`. A `list` call with `{}` was
   therefore **allowed** by the rule and then **denied** by its own re-assertion, because
   the grant covered nothing. Grant bookkeeping now records the wildcard.
2. The call identity was only `(call_id, action)`. A tool-call id is a correlation token
   unique among the calls of one response, so an id reused later is a *new* call. Identity
   is now `(turn, call id, action)`: a reused id in a later turn is decided on its own
   merits, while a replay **inside** its issuing turn is still refused.
3. `AuditedGate::authorize` recorded a `policy_decision` for *every* pass, so the
   single-use spend appeared in the chain as a second outcome for the same call. The trait
   now has `consume` for the effect boundary, which spends the grant and decides nothing;
   one call records exactly one decision and the spend is ticket lifecycle.

`PermissionRequest` gained a `turn_id`; `PermissionGate::consume` defaults to `authorize`,
so a stateless gate is unchanged. The mock provider now mints a unique call id per
response, as a real provider does — that fixture defect is recorded as `AX-356` rather
than absorbed. Contracts updated in `ARCH/12` §Tickets + Interfaces and `ARCH/10`
§Permission assertion; `F-66` rewritten in `ARCH/24` as closed with its residual.

**Second pass, continued — `AX-356` (the residual of `F-66`).**

`ARCH/08` §Admit batch already required it: "on the completed response, validate IDs, schemas,
sizes, ordering metadata … a batch-level defect (invalid encoding/schema, **duplicate ID**,
oversized response, or stale workspace fence) dispatches none of its calls". Admission did not
implement the ID check, so a provider that reused a correlation id was refused deeper down, by
the gate, as if the *call* were being replayed. The runner now remembers the ids it has admitted
in a turn and refuses a response that repeats one, before the assistant message is appended or
anything is dispatched; the turn ends failed with a reason naming the id, recorded as a
`protocol` failure class (a new `FailureClass` value, additive). Tests: two unit tests over the
admission helper and an end-to-end test that drives a real duplicate-id response and asserts both
the typed refusal and that only one tool result exists. **Not covered:** an id reused across
turns of one session is still admitted; that history scan belongs with the run stream (`AX-309`).

**Second pass, continued — `AX-354` (`F-65`), the last red test.**

The bounded preimage spike answered the finding's question with exact matches: the pinned
constants are `blake3("agentx/audit/genesis/v1")` and `blake3("agentx/audit/roots/genesis/v1")`.
Neither side was a random typo — the constants were correctly derived from the *pre-rename*
labels, and commit `58569f4` renamed the labels without re-deriving them. The label is
authoritative: it is the format's documented identity and what a verifier recomputes. Both
constants are now `blake3(<current label>)`, the original assertions stay, and a new test in
each module pins the pre-rename value and refuses it
(`the_pre_rename_genesis_is_not_accepted_as_genesis`). The migration consequence is recorded
in `ARCH/14` §Genesis derivation: the pre-rename derivation was never shipped, and a store
that starts from it is refused at sequence 0 rather than accepted under a compatibility rule.
With this, the workspace has **no failing test**.

**Third pass — breadth program, first slice: `AX-008` (`horizoncode-config`).**

A new `horizoncode-config` crate is the one owner of discovery and validation
(`ARCH/18`): the layer walk (global first, then project outer-to-nearest, with a path
that exists but is unusable reported as an issue instead of being skipped), the JSONC
reader the guard now consumes instead of keeping a second copy, the typed settings
merge with per-key provenance (`SettingView`: requested/effective values, scope,
source, contributors, shadowed sources, validation error, apply boundary, schema
version, effective digest), and hierarchical `AGENTS.md` discovery with
canonical-path and digest dedupe, exact rendering, and the fail-closed unreadable
case. The first schema group is the small set this slice's consumers need
(`instructions.extra`, two accessibility flags, the terminal-bell preference); the
other `ARCH/18` groups register in the same registry as their owners land, so no
second settings engine appears. Building it surfaced `F-67`: all five state-root call
sites documented `~/.horizoncode` and implemented `$HOME`. `horizoncode_config::
state_root()` is now the one resolver (`$HORIZONCODE_HOME` → `~/.horizoncode` → `.`),
all three branches are unit-tested, and the session, audit, analytics, guard, and CLI
roots consume it (`AX-357`). Not covered here: injecting the rendered instruction
source into the assembled context is `AX-319`.

**Fourth pass — `AX-010` (third-party notices and the provenance bundle).**

`horizoncode notices generate` renders `THIRD-PARTY-NOTICES.md` from `Cargo.lock`
and the license/notice files of the package sources present for the generating
platform; the bundle is embedded in the binary, so `horizoncode --credits` prints
exactly what ships and works with no HOME, store, or provider. The gate is not byte
equality — which sources are unpacked varies by machine — but three rules: the
bundle's named lockfile digest must match `Cargo.lock`, every locked package must
appear and nothing else may, and every locally present package must be in the
resolved table with its shipped license expression and all of its notice texts. A
locally built package can therefore never be hidden in the unresolved section or
lose its notice. `horizoncode notices check` exposes the gate to a release script
(exit `1` when stale). The dependency allowlist (`G-1`) and `Adapt`/`Vendor`
provenance records are still open and named in the row.

**Fifth pass — `AX-348` decision slice: finite storage ceilings.**

`ARCH/07` and `ARCH/28` both said the numeric defaults were a pre-implementation
decision, and `AX-309`/`AX-350` are gated on them, so this pass publishes them as
`DEC-058`: per-record, per-segment, per-stream, control-reserve, replay-batch,
artifact inline/object/namespace, decoded media, retention, and orphan-grace values,
each finite and nonzero, with the segment numbers mirroring the audit store's
4,096-entry / 8 MiB precedent. The same decision records the durability posture:
Linux is the reference backend, macOS carries a declared contract, and Windows
cannot sync a directory through the standard API, so `run_durable` is **refused
typed** there rather than silently weakened. The `horizoncode-config` schema now
carries all 22 keys with the values as defaults *and* compiled ceilings, so a
configuration or project may lower a limit but never raise it and zero is rejected;
typed `LogLimits`/`ArtifactLimits` views are what the storage work will consume.
The artifact store itself (`BlobRef`, quota reservation, GC) is the next step in
`AX-348`, not this one.

**Sixth pass — `AX-358`: the shared segmented event-log core.**

`DEC-055` says session and run history use one bounded segmented framing, so
`horizoncode-eventlog` now implements it: the canonical envelope with a `blake3`
digest over a versioned domain and recursively sorted keys (`DEC-059`), segments
that rotate on the `DEC-058` ceilings, seals synchronized before a successor
segment receives a record, an atomically replaced committed head with typed
absent/malformed/unreadable states, an OS-backed writer lock, streaming replay
with a per-line ceiling, refusal of a newer schema version before any segment is
decoded, and bytes beyond the head preserved and reported rather than truncated.
The commit order is pinned by tests: a line is durable before the head
acknowledges it. The suite is 14 unit tests plus 12 log cases (round trip,
rotation by events and bytes, oversized and stream refusals, restart resume, torn
and complete tails, a corrupt sealed segment, the version refusal, a second
writer, an empty log, and a refused durability backend). The session store still
uses its single-file layout until the `AX-350` migration; run payloads and
projections are `AX-309`; tail recovery is `AX-311`. The notices gate did its job
on the dependency change: the regenerated bundle is part of this commit.

**Seventh pass — `AX-344`: the typed command registry and reference parser.**

`horizoncode-commands` now owns the registry both the headless surface and the
future TUI consume. Only commands whose owner exists are registered (`/help`,
`/commands`, `/usage`, `/insights`, each naming its owner and effect class);
unknown names return typed errors with nearest-name suggestions, malformed
arguments name the grammar, unavailable owners and unsupported surfaces are
typed refusals, and help, search, and completion are generated from the same
registry. The CLI's ad-hoc `/usage`-only parser is gone; `/usage` now takes no
arguments (the old `--all` was accepted and ignored, which is exactly the
plausible-no-op the architecture forbids). The composer-reference parser
recognizes the six namespaces, keeps bare `@name`, email, escaped, and
unknown-delimiter text literal, diagnoses unknown namespaces without blocking,
and supports quoted paths; parsing is never resolution and grants no authority.
Black-box tests prove the safety property: an unknown command exits `4` with
suggestions and prints no answer with no provider configured.

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
- `cargo test --workspace --no-fail-fast` — **479 passing, 0 failing** at this revision
  (the count grows with the new suites; the totals above are per-run, not additive across
  passes). The two `F-65` genesis failures measured at baseline `b677443` are fixed under
  `AX-354`; the two `F-66` failures measured earlier in the day went green under `AX-355`.
- `cargo test -p horizoncode-config` — 28 tests: 7 unit (JSONC edge cases, the three
  `state_root` branches), 4 discovery, 11 settings/provenance (including the
  `DEC-058` defaults table, the lower-only/zero refusals, and the typed limit views),
  6 instructions.
- `cargo test -p horizoncode-eventlog` — 26 tests: 14 unit (envelope canonicalization
  and verification, seal digest coverage, content digest, head states/versions) and 12
  log cases.
- `cargo test -p horizoncode-commands` — 18 tests over the registry (owners, uniqueness,
  documented arguments, refusals with suggestions, help/search/completion, surface
  gating) and the reference parser (namespaces, quoting, escapes, spans, diagnostics).
- `cargo test -p horizoncode-cli --test commands_cli` — 6 black-box cases: help/list
  without a provider, an unknown command exiting `4` with suggestions and no output, a
  malformed argument naming the grammar, and an unknown help topic.
- `cargo test -p horizoncode-cli` — includes the notices gate: 5 unit tests (the
  generator's lock parsing, rendering, determinism, and the four refused edits) and 3
  black-box tests (`--credits` with no configuration, `notices check`, `notices
  generate --output`).
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
- A tool-call id is a correlation token, not a globally unique identity: scoping grants to
  `(turn, call id, action)` is the fix that makes an id collision across turns stop denying
  legitimate calls, while in-turn replay protection is unchanged. Any test that builds two
  requests for "the same call" must give them the **same** turn, or it is testing two calls.

## Next exact steps

0. Decide whether to format the rest of the tree in its own change, so the documented
   `cargo fmt --all --check` baseline becomes enforceable (`AX-121` builds the gate that
   would catch this). Every file this handoff's passes touched is `rustfmt`-clean; the
   workspace-wide check still reports the 67 pre-existing diffs.
1. Nothing from these passes is uncommitted: the working tree is clean except the
   user-owned untracked `uipics/` and `.code-intelligence/`.
2. The **`AX-350` session migration** onto `horizoncode-eventlog`: bounded
   digest-linked segments, committed head, streaming replay, event-byte quota and the
   protected control reserve, keeping the read-only/typed-enumeration contract stable.
   The run-log half waits for `AX-309`/`AX-312`.
3. Then the rest of `AX-348` (the bounded content-addressed artifact store:
   `BlobRef`, quota reservation, durable write-before-event ordering, typed states,
   GC), now that its defaults are published; then the TUI and settings surfaces
   (`AX-009`, `AX-343`), which consume the command registry just landed, then skills
   (`AX-110`) and MCP (`AX-106`, `AX-332`). `AX-010` and `AX-344`'s headless half are
   done; their remaining work is named in their rows, and `DEC-058`'s numbers may be
   revised only by a new decision.
4. `AX-311`: the effect journal, which unblocks `AX-351`'s recovery half and gives
   `ACC-P1-06`/`ACC-P1-12` their recovery evidence.
5. Then the rest of the controller chain (`AX-301`, `AX-310`, `AX-312`, `AX-313`,
   `AX-317`, `AX-337`, `AX-347`) before any multi-hour claim. The remaining breadth rows
   (agent directory and ACP client/pools, repo map/LSP, checkpoints/rewind,
   host probe, config recovery, peer adapters, delegation measurement,
   eval/perf, safety/config/provenance) follow in the dependency order recorded in
   §Active goal.

## Unresolved questions

- ~~Which side of F-65 is authoritative~~ Resolved 2026-09-28: the label is authoritative,
  the pre-rename derivation is refused, and the migration consequence is recorded in
  `ARCH/14` (`AX-354`).
- ~~Whether provider-response admission should reject a duplicate call id or repair it~~
  Resolved 2026-09-28: reject, before dispatch, with a typed reason (`AX-356`).
- How the `DEC-058` numbers perform on real workloads: they are published ceilings,
  deliberately conservative, and may be revised only by a new decision with a
  schema-version note. No benchmark has run yet.
- Whether `AX-350`'s session migration needs a format-version bump for the segmented
  layout: the session header currently names `CURRENT_FORMAT_VERSION`, and the new
  stream carries its own `CURRENT_SCHEMA_VERSION`; the migration must define how the
  two relate before it lands.
- The `session.log.*` / `run.log.*` finite defaults (`AX-348`): not yet chosen, and they
  gate AX-309 slice 1 and AX-350.
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
7. `fix(guard): stop denying a read-only call at its own effect boundary`
8. `docs: close F-66 and record the admission gap it exposed`
9. `docs(review): mark the findings wave 1 actually addressed, and say what remains`
10. `fix(loop): refuse a provider batch that reuses a tool-call id`
11. `fix(audit): re-derive the genesis constants from the labels they claim`
12. `docs: close F-65 with the spike evidence and the migration note`
13. `feat(config): resolve layered settings, instruction discovery, and one state root`
14. `docs: record the config slice, F-67, and the unified state root`
15. `feat(cli): ship and gate the third-party notices bundle`
16. `docs: record the notices bundle and its gate`
17. `feat(config): carry the storage ceilings with lower-only validation`
18. `docs: publish the finite storage ceilings before the storage code`
19. `feat(eventlog): add the shared event envelope and commit durability backend`
20. `feat(eventlog): add bounded segments, a committed head, and streaming replay`
21. `docs: record the shared segmented event-log core`
22. `feat(commands): add the typed slash-command registry and reference parser`
23. `docs: record the command registry and the reference parser`

Each commit is self-contained and builds; commit 2 carries the workspace manifest,
so its body notes the MSRV move that commit 4's OS-backed lock depends on.

## Worktree preservation

The user-owned untracked `uipics/` and `.code-intelligence/` are preserved and were not
staged. No remote was touched, nothing was pushed, published, or deployed, and no
production data was changed. Two temporary baseline worktrees were created under
`/tmp/opencode` for the failure comparison and were removed.
