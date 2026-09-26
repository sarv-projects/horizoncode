# 23 — Verification

## Purpose

Define how a claim in `ARCH/` becomes **evidence**, at what layer that evidence is
allowed to be produced, and what a release may therefore assert. The rules that
matter most:

1. **A passing unit test proves that tested behavior, nothing more.** Containment is
   proven by an acceptance run on a real platform, not by a mocked syscall.
2. **A lower layer never raises a claim a higher layer owns.** A passing contract test
   never proves a wire protocol; a mock never proves a transport.
3. **No claim ships without evidence.** "Implemented but unverified" is a legitimate,
   honest state — it must be *labeled*, never implied complete.
4. **The gate must be runnable when the feature lands.** A gate that can only be
   satisfied retroactively is not a gate (`DEC-016`).
5. **Determinism is a test property, not a hope.** No wall-clock time, no real
   network, no live model, no machine-dependent input in any test.

This document owns the layered strategy, the determinism/flake policy, the P1
acceptance matrix, performance budgets, release gates, the definition of done, and
where evidence artifacts live. `ARCH/22-SECURITY.md` owns *what must be proven*;
this document owns *how it is proven and retained*.

## Scope

**In scope.** Verification of every `CMP-*` component and every `REQ-*` in
`ARCH/02-REQUIREMENTS.md`; the test layers and their exit criteria; the P1
acceptance matrix; determinism and flake policy; performance budgets and how they
are measured; release gates; the definition of done; and the production, naming, and
retention of evidence artifacts.

**Out of scope (handled elsewhere).** What the security boundary *is*
(`ARCH/22-SECURITY.md`); which mechanism implements a control (`ARCH/12`, `ARCH/13`,
`ARCH/14`); the compression/routing eval methodology itself (`ARCH/19`, `ARCH/09` §5,
`ARCH/11` §Lifecycle) — this document requires that those gates run and are recorded,
it does not re-define them; product/UX acceptance beyond the accessibility and layout
properties stated in `ARCH/06-UI.md`; and legal/licensing determination
(`DEC-011`, `DEC-012`).

## Strategy

### Layered strategy

Each layer answers a different question. Evidence from a layer is valid only for its
own question.

| Layer | Question | Real dependencies | May assert | Must **not** assert |
|---|---|---|---|---|
| **L1 — Unit** | Does this function compute the right thing, including at its boundaries? | None beyond pure crates; injected clock/id/rng/fs abstractions | Local determinism, error mapping, boundary arithmetic, canonicalization and glob semantics, hash-chain math | Anything about the OS, a process, a socket, or a protocol |
| **L2 — Contract** | Does each `CMP-*` honor its declared interface, schema, and failure contract? | Real types; fake ports for collaborators | Interface conformance, typed failures, fail-closed behavior, schema validity, "no second permission path" static gates | End-to-end effect execution; platform containment |
| **L3 — Integration** | Do real components compose correctly with real OS resources? | Real temp roots, real child processes under the local backend, loopback HTTP servers, real VCS worktrees, mock provider transport | The governed path per effect class; confinement behavior on the host kernel; audit chain mechanics; session replay and repair | Cross-platform claims; client/UI behavior |
| **L4 — E2E** | Does the built binary complete a real user-visible task from the outside? | The release build; a scripted ACP stdio client; headless invocation; a scripted TUI session | Protocol handshakes, permission round-trips, exit codes, one full coding task in a real workspace | Tier-specific containment depth; anything on a tier not exercised |
| **L5 — Acceptance** | Does the claim hold on a real platform, with a real anchor, against the declared trust model? | Real OS, real confinement backend, a real anchoring sink at the declared level, real user | Containment per tier, the tier's **declared** network guarantee level, anchoring at a declared level, Windows/macOS limits, performance baselines | Anything not recorded with build id, platform, and exact commit |

**Layer exit criteria (all must hold to leave a layer).**

- **L1 → L2:** every branch that can change a decision or a byte count has an
  assertion, including the "deny" and "refuse" branches; no assertion depends on
  iteration order of a hash map.
- **L2 → L3:** every inbound interface has at least one happy-path test, one typed
  failure test, and one **fail-closed** test (error, timeout, unavailable
  collaborator) — a component with no fail-closed test is not contract-complete.
- **L3 → L4:** the full governed path (authorize → confine → execute → record) is
  exercised at least once per declared security-relevant effect class, and at least
  once per *refusal* path in `ARCH/22` §Failure modes.
- **L4 → L5:** every user-visible capability is driven from outside the binary at
  least once, and every readiness claim has a named acceptance record path.
- **L5 (release):** the gates in §Release gates pass with retained records.

**Anti-claims (stated so they cannot be quietly relied on):**

- A unit test with a mocked filesystem cannot prove containment.
- A mock provider transport cannot prove a wire protocol, a retry policy against a
  real rate limiter, or prompt-cache behavior.
- A CI run on one platform cannot prove another platform.
- A browser/simulated surface cannot prove the real surface.
- A static catalog entry cannot prove a provider works.
- A unit-only result never satisfies a readiness claim for a risky capability class.
- A static architecture gate can prove that **no path-policy evaluation exists outside
  the guard** and that a path-shaped `exec.run` rule is rejected at load; it cannot
  prove that a particular path *would* be denied at runtime — that needs the L3
  governed-path run (`REQ-SEC-023`, `REQ-SEC-025`, `DEC-025`).
- A passing containment run proves the tier's **declared** network guarantee level,
  not a universal "no outbound network" claim for every platform; a stronger level is
  proven only by the mechanism named in the record (`DEC-026`, `REQ-GUARD-004`).
- Audit verification proves modification of already-anchored history is detected. It
  does not prove content authenticity, does not detect fabrication by a principal
  with write access, and does not cover the unanchored tail (`REQ-AUDIT-007`).

### P1 acceptance matrix

The P1 phase (`TODO.md`, "Safe agent you can trust") has one exit: *a guarded,
sandboxed, audited coding task; policy changes behavior with no code change*. These
eight rows are the concrete, falsifiable evidence for that exit. Each row is a gate:
a skipped sub-check fails the row.

| ID | Item | What is proven (sub-checks) | Method | Pass criterion | Evidence artifact |
|---|---|---|---|---|---|
| `ACC-P1-01` | **Sandbox containment**, per supported tier | (a) a command cannot read a deny-globbed path; (b) cannot write outside the writable roots; (c) cannot rename a denied path out of the deny set and then read it; (d) with `network: none`, the tier's **declared network guarantee level** is the assertion — for `enforced` (Linux), `connect`-class syscalls are denied and only `AF_UNIX` sockets succeed; for `capability` (Windows), the AppContainer network capability is absent and an outbound attempt fails; for `best_effort` (macOS), the Seatbelt rule denies the wrapped process **and** the residual (an escaped descendant is not separately confined) is proven disclosed in the surface and the record; (e) with an allowlist, only granted `host:port`+protocol succeed; (f) effective/permitted capability set is empty after setup; (g) with the backend removed, the effect is **denied and audited**, not run unconfined; (h) namespace rearrangement, VM-socket bridging, and synthetic-mount cleanup all fail with a violation and a non-zero outcome; (i) reads are scoped to the granted roots on **every** tier, and a spawn naming an absolute path outside them is rejected or masked; (j) a caller requiring a network level the tier does not provide is **refused**, never downgraded | L3 + L5. Temp workspace with a deny-glob tree; a loopback listener bound to an ephemeral `127.0.0.1` port for (e); for (d) the **primary** proof is the tier's declared mechanism — for `enforced` the syscall-level assertion (filter denies `connect`/`bind`/… and restricts `socket` to `AF_UNIX`) with the loopback listener as corroboration, because loopback reachability alone is explicitly *not* proof of "no network" | every sub-check denies; **observed behavior, the declared level, and the recorded residual agree**; a tier claiming a stronger level than it proves **fails** the row; no sub-check skipped; a skipped sub-check fails the run; the suite runs against each tier that advertises support | `acceptance/sandbox/<tier>/<build-id>.json` (including `network_guarantee_level`, `network_mechanism`, `network_residual`) + raw output + kernel/runtime versions |
| `ACC-P1-02` | **Guard precedence** | deny > ask > allow across multiple resources; the outer-scope deny ceiling is non-overridable; plan mode forces deny for every mutating class; unmatched ⇒ `deny` by default, may be `ask`, **never** `allow` in any layer; a malformed rule layer falls back to the previous valid layer and never widens; find-last-wins ordering; ticket scope/uses/expiry/epoch validation including the concurrent-use race; the persisted "always" rule equals the displayed pattern byte-for-byte; the built-in external-directory floor rule raises an outside-root `fs.*` resource to `ask`, is overridable toward `deny` and never toward a silent allow; a path-shaped `exec.run` rule is rejected at config load; a `bash` request carries the command-prefix resource **and** the extracted `fs.*` resources, and the guard returns exactly one decision over the combined set | L2 + L3. A committed **decision table** enumerating rule-order *classes* (deny-only, ask-only, allow-only, mixed, ceiling conflict, unmatched, malformed, multi-resource mixed effects, yolo-composition, plan-ceiling) — not an exhaustive permutation count — plus a **static L2 assertion** that a path-shaped `exec.run` resource is rejected at load and that **no path-policy evaluation is produced outside the guard** | the table is exhaustive over the declared classes; each row asserts exactly one effect; a test fails when the evaluator's semantics and the class list disagree; the yolo and plan rows are present; the floor rule never lowers a decision; the static gate fails on a second path evaluator | golden decision table + test report + the saved-rule store diff + the static-gate report |
| `ACC-P1-03` | **Approval round-trip through the ACP permission path** | a guard `ask` becomes **exactly one** `session/request_permission` request carrying the tool-call descriptor and the fixed option set; the client's reply is recorded verbatim and drives the decision; a client that does not advertise the permission capability resolves to **reject**, never allow; a client disconnect mid-request resolves per the configured timeout policy (default deny) and is audited; a second concurrent request is serialized per session; a reject ends the turn `declined` and is **not** converted into model-facing output; allow-always persists exactly the shown pattern and is shown pre-confirmation; the recorded reply is verifiable in the audit trail | L3 + L4. A scripted ACP stdio client over an in-process pipe (no network) that records every frame it sends and receives | the audit trail contains exactly one approval entry per request; the recorded reply equals the client's reply; the turn's terminal state matches the reply; the unadvertised-capability case records a reject | paired NDJSON transcripts (server + client) + the audit segment for the run |
| `ACC-P1-04` | **Audit chain verify + coverage census** | `audit verify` succeeds on an untampered run; for a **negative-control copy** it detects each of added / removed / reordered / truncated / modified entries and names the failing `seq`; the coverage census maps every declared effect class to ≥1 entry and **fails loudly** on an injected uncovered class; a redaction canary is absent from every entry, root, verify output, replay output, and export; cross-store reconciliation flags a referenced effect with no audit entry and an audit entry with no session fact; the record stores the **anchoring level** actually in force (`local-trust` \| `local-sink` \| `off-box`); for `local-trust` and `local-sink` the rendered `verify` output states the `REQ-AUDIT-007` claim boundary — modification of already-anchored history only, no content authenticity, no fabrication detection, no coverage of the unanchored tail — and never renders `local-sink` as `off-box`; an unanchored run is labeled `local-trust` and an anchored run names its anchor | L3 + L5 (anchoring needs a real sink) | all six tamper classes detected; census exits non-zero on the injected gap; canary absent by byte comparison; both reconciliation directions flagged; the stored level, the rendered level, and the rendered claim boundary agree, and a `local-sink` run rendered as `off-box` **fails** | tamper-detection report, census artifact, canary scan output, anchor sink receipt, rendered-claim-boundary capture |
| `ACC-P1-05` | **ACP stdio handshake with capability advertisement** | `initialize` negotiates a protocol version and advertises **only implemented** methods; every optional call is capability-gated and an ungated call is refused typed; `session/new`, `load`, `resume`, `list`, `close`, `fork` map to the store lifecycle; streamed updates use one typed vocabulary with no opaque chunk channel; unknown method or malformed frame yields a typed protocol error with session state unchanged; a second surface claiming the same session is rejected; the edge SDK is framing-only | L4. In-process stdio + a schema conformance check against the negotiated schema version | the advertised method set equals the implemented method set, checked by a **generated list diff** so drift fails the build; schema conformance passes; every negative case is typed, never a crash or a silent no-op | handshake transcript + method-coverage diff artifact |
| `ACC-P1-06` | **Session replay/resume determinism** | replaying the same log twice yields **byte-identical** projections; an open tail is repaired deterministically (same synthetic closers, same `seq`, same bytes); a crash mid-turn loses no committed step; `fork` at a boundary produces a child whose inherited prefix is exactly the parent's events through the cut; the index rebuilds from the log to identical rows; a log whose stored format is newer than the build is refused typed with **no partial decode**; a moved workspace root is refused with re-point guidance and never guessed; per-key ownership admits one drain and a second resume joins | L3 + L4. Real process kill/restart (not a simulated crash) + committed golden transcripts | golden comparison is byte equality for projections and repair output; the kill/restart matrix runs ≥20 times with zero divergence; the newer-format case produces zero decoded events | golden transcript hashes + the restart matrix (per scenario, with the divergence count) |
| `ACC-P1-07` | **Compaction continuity** | after compaction the post-compaction context still contains every fact in the pre-registered probe set; a boundary never splits an assistant tool call from its result; an unbalanced span is rejected in favor of a safe adjacent range; a provider overflow triggers **exactly one** compact-and-retry of the same step and a second overflow is terminal; a failed summarize call leaves the turn un-compacted rather than half-compacted; the checkpoint records the shadowed range and count and the log is never rewritten; the stable prefix is byte-stable until a real change | L3 (mock provider) + the offline retrieval probe | probe recall = 100% on the pre-registered set; zero unbalanced spans; the exactly-one-retry assertion holds; prefix-stability holds | probe-set results keyed by strategy version; paired A/B report when a strategy changes (`DEC-016`) |
| `ACC-P1-08` | **Headless exit codes** | every terminal state maps to exactly one documented code; `declined`/guarded-deny and `completed` differ; an interrupt emits its terminal event **before** exit; `--format json`/`ndjson` emits one typed event per line and a bounded buffer surfaces a typed error rather than dropping events; a configuration error is distinct from an internal error; a resume of a nonexistent session is a configuration error; a signal mid-turn yields `interrupted` plus the documented code; the numeric mapping in `--help` matches the implementation | L4 on the release build | the code table is asserted per terminal state; a test fails if the table and `--help` disagree; the NDJSON stream is schema-validated line by line | exit-code matrix artifact + the `--help` contract snapshot |

**Forward-declared (later phases, not P1 gates).** `P2`: repo-map/LSP/indexing
determinism; checkpoint/rewind round-trip; deterministic merge arbitration given
identical inputs; routing eval-gate evidence (`ARCH/11` §5). `P3`: worktree lease and
merge under concurrency; task-graph durability across compaction/restart; peer-pool
supervision; WASM skill/plugin confinement. Each is declared here so the evidence path
is agreed before the feature exists, not after.

### Determinism and flake policy

**Injectable substrate (a hard prerequisite for any test).** No test may reach the
real world for any of these:

| Injected | Rule |
|---|---|
| Clock | A `Clock` trait (monotonic + wall) with a test implementation. TTLs, deadlines, retry backoff, and budget windows read it. **No `sleep`-based synchronization anywhere.** |
| Identifiers | A uuid source injected per test; golden transcripts must not depend on minted ids unless the id source is frozen. |
| Randomness | A seeded RNG; jitter is production-random but seed-injectable in tests. |
| Home / state dir | A per-test temp root; no test reads the developer's real config, state, or `HOME`. |
| Environment | A per-test env map; no test mutates the process environment globally. |
| Transport | Provider and HTTP are exercised through mock/in-process transports. |
| Process/sandbox | `SandboxProvider::probe` is injectable so backend-absence can be tested without uninstalling anything. |

**Transport rules.**

- **Mock provider transports only.** A deterministic scripted transport returns a
  recorded request/response sequence; it can inject a typed overflow, a rate-limit
  hint, a malformed frame, and a pre-content interruption.
- **Loopback servers only.** Any test that needs a socket binds `127.0.0.1`/`::1` on
  an ephemeral port. A helper wraps the HTTP client so an attempted connection to a
  non-loopback destination **fails the test loudly** rather than reaching the internet.
- **No live model, ever.** No test may require an API key, a network route, or a real
  provider account. Provider-specific behavior is asserted through adapter conformance
  fixtures recorded from the wire format, marked with the date they were captured.

**Determinism rules.**

- No wall-clock timestamps in assertions. Where a timestamp is part of the record,
  assert ordering and monotonicity, or use the frozen clock.
- No dependence on hash-map iteration order, filesystem enumeration order, thread
  scheduling, or `PATH` ordering. Any place that needs a deterministic order declares a
  total order explicitly.
- No dependence on locale, timezone, or `TZ`.
- No dependence on the host's filesystem, temp-directory location, username, or
  network conditions.
- Golden files are committed. A golden diff must be **reviewed**, never auto-accepted
  by an update flag in the same change that caused it.
- Randomized/fuzz testing uses a **recorded seed**; the failing seed is committed as a
  regression corpus entry.

**Repeat and quarantine policy.**

- The full suite runs **≥5 consecutive times** on the merge gate with zero failures.
- The determinism-sensitive suites (`ACC-P1-01`, `ACC-P1-04`, `ACC-P1-06`,
  `ACC-P1-07`) and any test using real processes run **≥20 repetitions**.
- **No silent quarantine.** A quarantined test requires an owner, a reason, a linked
  issue, and an expiry date; a quarantined **security-relevant** test is an immediate
  release blocker. Quarantine count is a reported metric, not a hidden flag.
- A flake re-opens the owning requirement's evidence: a requirement that flaked has
  not demonstrated determinism, regardless of its pass rate.
- Every test has an explicit timeout. A hang is a failure that dumps the last events,
  not a stuck job.

**Adversarial-input coverage.** Parsers for untrusted formats — protocol frames,
config, tool input/output, patch text, package archives, catalog records — have fuzz
targets. A crash, an unbounded allocation, or a panic found by fuzzing is a release
blocker, and the minimized input is committed to the corpus.

### Performance budgets

**Measurement discipline (a budget without a recorded baseline is *unmeasured*, not
passing).**

- A repeatable benchmark procedure with a **recorded machine baseline**: CPU model,
  core count, RAM, OS/kernel version, filesystem, build profile, and whether the
  index/cache was warm.
- Budgets are stated as p50/p95 with a sample count and a defined workload.
- A budget is reported as *met*, *missed*, or **unmeasured**. *Unmeasured* may not be
  reported as *met*.
- A budget is never met by weakening a security control. If a budget and a control
  conflict, **the control wins** and the budget is renegotiated with recorded evidence.

**Budgets.** Values marked *(provisional)* are targets to be replaced by a measured
baseline before the corresponding release gate closes; they are stated so the shape of
the budget is agreed now, not so a number can be quoted as fact.

| Budget | Target | Workload definition |
|---|---|---|
| Startup to interactive prompt, warm cache | p50 ≤ 250 ms, p95 ≤ 600 ms *(provisional)* | Release build, warm index and catalog cache, synthetic 200-file repo, no network |
| Cold start with no network (curated primary catalog only, no enrichment cache) | p50 ≤ 700 ms *(provisional)* | Same, release build, catalog enrichment disabled, no network |
| ACP `initialize` → ready | within the warm startup bound | Release build over a pipe |
| Render | full-frame redraw p95 ≤ 16 ms; a 100k-line transcript redraw touches only visible rows + the mutable tail | Synthetic transcript; the live region is virtualized (`REQ-PERF-002`) |
| Tool-output capture and bounding | decision p95 ≤ 20 ms for a 50 MiB streamed capture | Bounded stream, spill path exercised |
| Repo-map incremental rebuild | p95 ≤ 250 ms for a ≤50-file delta, never on the loop path (`REQ-PERF-003`) | Warm index, 50 changed files |
| `audit verify` | ≤ 2 s per 100k entries, full chain | Synthetic chain on local disk |
| Session replay | ≥ 10k events/s, single-threaded | Synthetic log |
| Memory ceiling | A stated per-session and per-subsystem ceiling, asserted in a soak run | 8-hour soak with a bounded workload |

### Release gates

A release is blocked unless **all** of these pass and their records are retained.

| Gate | Requirement |
|---|---|
| `G-1` | License allowlist check passes; every `Adapt`/`Vendor` entry has a complete in-tree provenance record (`DEC-012`, `ARCH/05` §4) |
| `G-2` | `THIRD-PARTY-NOTICES` is generated from the resolved dependency graph and shipped with the binary (`DEC-011`, `AX-010`) |
| `G-3` | Full suite green with zero quarantined tests across ≥5 consecutive runs; the determinism-sensitive suites across ≥20 repetitions |
| `G-4` | Containment acceptance (`ACC-P1-01`) passes for **every** supported tier, with a record per tier, and each record **names that tier's `network_guarantee_level`**, its mechanism, and its residual (`DEC-026`); a tier claiming a stronger level than it proves fails |
| `G-5` | `audit verify` and the coverage census pass on a fresh run; the record stores the anchoring **level** in force, root anchoring is configured per the declared trust model, the rendered claim boundary matches that level (`REQ-AUDIT-007`), and a configured-but-unreachable anchor **fails** rather than degrading |
| `G-6` | The headless exit-code contract matches `--help` (`ACC-P1-08`) |
| `G-7` | The session-format migration chain compiles, round-trips, and refuses a newer stored version |
| `G-8` | Performance budgets are measured with a recorded baseline, or an unmeasured budget is explicitly disclosed and is **not** a P1 exit criterion |
| `G-9` | No forbidden brand name in source, help text, shipped docs, or the notices bundle (excluding license-mandated attribution) — `REQ-VISION-003`, `DEC-011` |
| `G-10` | Fuzz corpus is clean for the current cycle, with no new crash/unbounded-allocation finding |
| `G-11` | Every eval-gated feature that ships has a runnable gate **at the time it shipped** (`DEC-016`); the paired-eval report is retained |
| `G-12` | Every `REQ-*` in a shipped capability has a traceability row naming its evidence, or is explicitly marked unimplemented |

### Definition of done

A capability is done when **all** of the following hold. A capability that fails any
line is **implemented but unverified** and MUST be labeled as such wherever it
appears.

1. The design document for the owning `CMP-*` exists and cites the `REQ-*` ids.
2. The implementation exists on the single governed path (no second engine, registry,
   scheduler, or permission system).
3. L1 and L2 tests exist, including every **deny** and **refuse** branch and at least
   one fail-closed test per interface.
4. L3 integration coverage exercises the governed path for every declared
   security-relevant effect class the capability can produce.
5. If user-visible, it is driven from outside the binary at least once at L4.
6. If it makes a **readiness** claim, an L5 acceptance record exists for the claiming
   platform/tier.
7. Failure modes listed in the component document have tests, not just the happy path.
8. A performance budget is measured, or explicitly recorded as unmeasured.
9. The `REQ-*` has a traceability row and its open questions are closed or explicitly
   deferred with an owner.
10. Residual risks are either mitigated or in the register (`ARCH/22` §Residual-risk
    register) with a treatment and a review date.

### Where evidence is produced and retained

```
<state-dir>/evidence/<build-id>/
  suites/            # per-layer test reports, repeat counts, quarantine list
  acceptance/
    sandbox/<tier>/  # ACC-P1-01 records + raw output + kernel/runtime versions
    guard/            # ACC-P1-02 decision-table report
    acp/              # ACC-P1-03 / ACC-P1-05 transcripts + method-coverage diff
    audit/            # ACC-P1-04 verify output, tamper report, census, anchor receipt
    session/          # ACC-P1-06 golden hashes + restart matrix
    context/          # ACC-P1-07 probe results per strategy version
    headless/         # ACC-P1-08 exit-code matrix + --help snapshot
  perf/              # baselines: machine description, raw samples, computed p50/p95
  fuzz/              # corpus + last run summary + committed crashers
```

- **Build id** is a content hash of the built artifact plus the exact commit, so a
  record cannot be attributed to the wrong build.
- **Retention:** full records are CI build artifacts attached to the build, retained
  for the release window. They are not committed to the repository (size and
  reproducibility concerns).
- **Committed** to the repository: golden corpora, the guard decision table, the
  compaction probe set, fuzz corpora, random seeds, and a small **acceptance index**
  mapping each `REQ-*` to the record that covers it.
- **A record is evidence only for the build id, platform, and tier it names.** It may
  never be presented as evidence for another build or another platform.

## Responsibilities

**Owned by this document's process (no single component owns it):**

- The layer definitions and their exit criteria.
- The acceptance matrix and its pass criteria.
- The determinism/flake/quarantine policy.
- The performance budget table and its measurement discipline.
- The release gate list and the definition of done.
- The evidence artifact layout, naming, and retention rules.

**Explicitly not owned:**

- Any effect, policy decision, or record — verification **observes**; it never
  authors an effect and never decides policy. The verification plane is a test-only
  consumer and must never become a runtime dependency.
- Test implementation details per component; those live with the component.
- The compression and routing evaluation methodology (`ARCH/19`, `ARCH/09` §5,
  `ARCH/11`), which this document requires to be run and recorded.
- Product acceptance criteria, which belong to `ARCH/01-VISION.md` and `ARCH/06-UI.md`.

## Interfaces

| Component | Verification seam |
|---|---|
| `CMP-runner` | Turn/step state machine, terminal-state contract, cancellation, fail-unsettled, step bound |
| `CMP-session` | Event-log append/replay/repair, checkpoints, fork boundary, migration chain, per-key coordinator |
| `CMP-context` | Assembly order, budget arithmetic, compaction trigger and continuity, prefix stability, epoch |
| `CMP-tools` | Schema decode/encode, materialization filtering, bounded output, the model/UI split, and the **extraction** of path-shaped shell arguments into `fs.*` resources — the seam asserts extraction only, never a path decision (`DEC-024`, `REQ-SEC-025`) |
| `CMP-provider` | **Mock transport seam**; adapter conformance fixtures; retry single-ownership; usage accounting; egress denial typing |
| `CMP-guard` | Decision table, tickets, approval lifecycle, modes, saved-rule exactness, the external-directory floor rule, the load-time rejection of a path-shaped `exec.run` resource, and the static gate that no other component evaluates path policy |
| `CMP-sandbox` | `probe` seam (for backend-absence tests), `check_path`/`spawn` as the only enforcement calls, per-tier read scoping, profile immutability, violation records, and the declared `network_guarantee_level` per tier |
| `CMP-audit` | Chain math, verify, census, anchoring, redaction, cross-store reconciliation |
| `CMP-orch` | Authority intersection, bounds, receipts, leases, deterministic merge |
| `CMP-acp` | **Scripted stdio client harness** for L4; capability gating; schema conformance |
| `CMP-mcp` | Loopback MCP servers (stdio child and streamable HTTP), pagination cap, dedupe, auth failure typing |
| `CMP-config` | Layer merge, schema rejection, project-scope narrowing only, secret-reference enforcement |
| `CMP-analytics` | Ledger/rollup rebuild, observed-vs-estimated, export sanitization |
| `CMP-tui` / `CMP-headless` | Layout stability (no shift on commit), truthful status, `NO_COLOR`/`TERM=dumb`/reduced-motion, exit codes |

## Data / state model

```
EvidenceRecord  = { build_id, commit, layer, suite, verdict, duration_ms,
                    environment{os, kernel, tier, backend}, repetitions }
Verdict         = pass | fail | unmeasured | skipped_blocked
AcceptanceRecord= { build_id, platform, tier, backend, sub_checks[{id, verdict,
                    evidence_ref}], operator_surface, notes,
                    network_guarantee_level, network_mechanism, network_residual,
                    anchor_level, anchor_claim_rendered }
Budget          = { id, p50, p95, samples, workload, machine_baseline, verdict }
Quarantine      = { test_id, owner, reason, issue_ref, expires_on }
TraceabilityRow = { req, owner_doc, code_paths, decision_refs, task_id,
                    evidence_ref, status }
Status          = unimplemented | implemented | implemented_verified | accepted | blocked
```

`verdict = unmeasured` is a first-class value. It is never rendered as `pass`, and a
requirement whose only evidence is `unmeasured` is `implemented`, never `accepted`.

## Flows

### 1. From requirement to evidence

```
REQ-*  →  design (ARCH/NN) cites it
       →  implementation on the governed path
       →  L1/L2 tests (deny + refuse + fail-closed branches)
       →  L3 governed-path integration per effect class
       →  L4 outside-the-binary drive (if user-visible)
       →  L5 acceptance record (if a readiness claim is made)
       →  traceability row updated
       →  release gates evaluated
```

A step that cannot be performed is recorded as `skipped_blocked` **with a reason**,
never silently omitted. A `skipped_blocked` acceptance row blocks the exit criterion
it belongs to.

### 2. Producing a containment record

1. Build in release mode; record build id and commit.
2. Create a temp workspace with a deny-glob tree and a `protected` path.
3. Apply the requested profile; record the resolved profile, the backend, and the
   tier's **declared `network_guarantee_level`** with its mechanism and residual.
4. For each sub-check: attempt the escape, record the kernel-level outcome, and record
   whether the violation was audited.
5. Repeat with the backend made unavailable via the `probe` seam → expect deny + audit.
6. Write the record with the platform, kernel/runtime versions, and every sub-check
   verdict. A missing sub-check is a failure, not an omission.

### 3. A flake is found

1. The repeat run fails; the failing seed/input is preserved immediately.
2. The test is **not** quarantined silently. Either it is fixed, or a quarantine entry
   is created with owner, reason, issue, and expiry.
3. If the flake is in a security-relevant test, the release gate is blocked until it
   is fixed.
4. The owning requirement's status is downgraded, because a flaking test has not
   demonstrated determinism.

### 4. Claim hygiene

Any place that shows a capability's status (TUI panel, headless status, docs table,
release notes) reads the traceability row. "Ready", "verified", "contained", and
"audited" are rendered only from `accepted`/`implemented_verified` with a linked
record. Otherwise the surface shows the weaker, true word.

## Failure modes

| Failure | Behavior |
|---|---|
| A test depends on a real clock, network, or machine state | The test is invalid; it is rewritten against the injected substrate, not retried until green |
| A golden file changes without a reviewed reason | The change is rejected; regenerating goldens in the same change as the behavior change is a review finding |
| A sub-check is skipped for lack of privilege or platform | Recorded as `skipped_blocked` with a reason; blocks its exit criterion |
| A mock diverges from the real transport | The adapter conformance fixture set is regenerated from the wire format and the mock corrected; the divergence is recorded with a date |
| An acceptance run happens on the wrong tier or build | The record is void (its own fields say so) and the gate is re-run |
| A benchmark runs on a loaded machine and is recorded as a baseline | The baseline is invalid; baselines record machine state and are re-taken on a quiet machine |
| Evidence is attached to the wrong build id | The record names its own build id and cannot be cited elsewhere |
| A unit test is cited as acceptance evidence | A traceability-status finding; the requirement drops to `implemented` |
| A quarantine exists at release time | Release blocked if any quarantined test is security-relevant; otherwise the quarantine list ships with the release notes |
| The configured anchor sink is unreachable | The gate fails; it never degrades to a local-only run presented as anchored (`DEC-022`) |
| The record names a network level stronger than the tier proves | The row fails; the level, its mechanism, and the residual are rewritten to what was observed, or the tier is refused the profile it cannot confine (`DEC-026`) |
| `verify` renders `local-sink` as `off-box`, or omits the claim boundary | `ACC-P1-04` fails; the rendered evidence is the artifact under test, so a weaker level presented as stronger is a failure, not a wording nit (`REQ-AUDIT-007`) |
| A path decision is produced outside the guard | The static architecture gate fails the build (`DEC-025`, `REQ-SEC-025`) |
| Fuzzing finds a crash or unbounded allocation | Release blocker; the minimized input is committed as a regression case |
| An eval-gated feature ships before its harness can run | Release blocked (`DEC-016`) |

## Configuration

Proposed verification key group (schema-versioned, discovered global → project, and
**project scope may only tighten** — it may not reduce repetitions, disable a layer, or
skip an acceptance row). This group is not yet in `ARCH/18`; see Open questions.

| Key | Meaning | Default |
|---|---|---|
| `verification.layers` | enabled layers | `unit, contract, integration, e2e` |
| `verification.repeat` | full-suite consecutive clean runs required on the merge gate | `5` |
| `verification.repeat_determinism` | repetitions for process/platform-sensitive suites | `20` |
| `verification.timeout_ms.default` | per-test default timeout | `60000` |
| `verification.golden_dir` | committed golden corpus location | repo-relative |
| `verification.evidence_dir` | local evidence root | `<state-dir>/evidence` |
| `verification.perf.baseline` | recorded machine baseline descriptor | required for a budget to be `measured` |
| `verification.quarantine` | per-test quarantine entries with owner + expiry | none permitted for security-relevant tests |
| `verification.fuzz.corpora` | committed corpora roots | repo-relative |
| `verification.anchor_required` | fail the gate when the configured audit anchor is unreachable | `true` |

## Requirements mapping

`REQ-VER-001..018` are added by this document. Discharging map: `REQ-VER-005..011` are
discharged by the **P1 acceptance matrix** (`ACC-P1-01..08`) — the matrix is not the
whole verification strategy; `REQ-VER-001/015/017` by the **layering, anti-claims, and
definition of done**; `REQ-VER-002/003` by the **determinism substrate and transport
rules**; `REQ-VER-004/016` by the **repeat/quarantine policy and fuzz coverage**;
`REQ-VER-012` by the **performance budget discipline**; `REQ-VER-013/014` by the
**release gates and evidence retention**.

| REQ | Where satisfied |
|---|---|
| `REQ-VER-001` | §Strategy layers + exit criteria; `implemented but unverified` labeling rule |
| `REQ-VER-002` | §Determinism — injectable substrate table |
| `REQ-VER-003` | §Determinism — transport rules (mock provider transports, loopback only) |
| `REQ-VER-004` | §Determinism — repeat and quarantine policy |
| `REQ-VER-005` | `ACC-P1-01` — the network sub-check asserts each tier's **declared** guarantee level rather than one universal no-network claim (`DEC-026`) |
| `REQ-VER-006` | `ACC-P1-02` |
| `REQ-VER-007` | `ACC-P1-03` |
| `REQ-VER-008` | `ACC-P1-04` |
| `REQ-VER-009` | `ACC-P1-06` |
| `REQ-VER-010` | `ACC-P1-07` |
| `REQ-VER-011` | `ACC-P1-08` |
| `REQ-VER-012` | §Performance budgets — measurement discipline (`unmeasured` is a verdict) |
| `REQ-VER-013` | §Release gates `G-1..G-12` |
| `REQ-VER-014` | §Where evidence is produced and retained — build id, platform, tier binding |
| `REQ-VER-015` | §Anti-claims + §Claim hygiene |
| `REQ-VER-016` | §Adversarial-input coverage |
| `REQ-VER-017` | §Definition of done line 3 + the failure-mode table (a fix without a regression test is not done) |
| `REQ-VER-018` | §Release gates `G-11`; generalizes `DEC-016`'s sequencing rule — see Open question 5 |
| `REQ-CTX-003`, `REQ-CTX-009` | `ACC-P1-07` probe + paired A/B; `G-11` |
| `REQ-PROV-005` | Routing eval-gate evidence is a P2 forward-declared item and a `G-11` obligation |
| `REQ-AUDIT-002`, `REQ-AUDIT-005` | `ACC-P1-04`; `G-5` |
| `REQ-AUDIT-004` | `ACC-P1-04` anchor receipt; `G-5` (an unreachable anchor fails) |
| `REQ-AUDIT-007` | `ACC-P1-04` stores the anchoring level and captures the rendered claim boundary; `G-5` (`DEC-022`) |
| `REQ-GUARD-004` | `ACC-P1-01(d)` per the tier's **declared** network guarantee level; `G-4` (`DEC-026`) |
| `REQ-SEC-003`, `REQ-SEC-025` | `ACC-P1-01` (reach) and `ACC-P1-02` (authorization + the static "no path evaluation outside the guard" gate) (`DEC-024`, `DEC-025`) |
| `REQ-SESS-002` | `ACC-P1-06` |
| `REQ-PROTO-001`, `REQ-PROTO-002`, `REQ-PROTO-006` | `ACC-P1-03`, `ACC-P1-05` |
| `REQ-PERF-001`, `REQ-PERF-002`, `REQ-PERF-003` | §Performance budgets |
| `REQ-UI-002`, `REQ-UI-003`, `REQ-UI-004`, `REQ-UI-008` | `CMP-tui` seam; L4 scripted-session rows |
| `REQ-VISION-003` | `G-9` |
| `REQ-SEC-001` | `G-1`, `G-2` |

## Open questions

1. **Where the acceptance index is committed.** The small traceability index belongs in
   the repository; its location, format, and update discipline (manual vs.
   generated-from-tests) are undecided, and generated-from-tests is attractive because
   it cannot drift.
2. **Evidence retention window.** "The release window" is not a number. How long full
   records are kept per platform/tier, and whether a superseded record is archived or
   deleted, needs a decision.
3. **`ACC-P1-01` on the remote/container tiers.** Container and micro-VM tiers are in
   the `SandboxProvider` abstraction; whether they get their own acceptance rows
   (beyond "the same suite runs against each tier that advertises support") is
   undecided.
4. **The compaction probe set's owner and threshold.** Who curates the pre-registered
   "must remain retrievable" facts, and what regression margin blocks a strategy
   change? `ARCH/09` Open question 5 raises the same item from the design side.
5. **Generalizing `DEC-016`'s sequencing rule.** `DEC-016` fixes "harness before
   gated feature" for compression. This document applies it to every eval-gated
   feature (routing included) as `G-11`. Making that a hard decision rather than a
   documentation practice requires a `DEC-*`; it is flagged, not assumed.
6. **The `verification.*` configuration group.** Proposed here but not yet part of
   `ARCH/18`'s key groups. It should be added there (with schema version and
   migration) or explicitly kept out of user configuration and made internal.
7. **TUI acceptance.** A scripted TUI session is the only way to prove
   `REQ-UI-003` (zero layout shift) and the accessibility properties. Whether that
   harness is in scope for P1 or lands with the cockpit in P2 is undecided; the
   `CMP-tui` seam is listed either way.
8. **macOS network-restricted profiles as an acceptance row.** **Resolved by
   `DEC-026`:** `ACC-P1-01` (d) **does** apply to macOS, as the `best_effort`
   assertion — the Seatbelt rule denies the wrapped process, **and** the residual (an
   escaped descendant is not separately confined) is proven to be disclosed in the
   surface and the record. macOS is **not** "unsupported" for a network-restricted
   profile: it is a supported tier at a declared level, and a caller requiring
   `enforced` receives a refusal. This is the same answer as `ARCH/22` Open question 4
   and `ARCH/13` Open question 5, so the three documents now agree by construction.
9. **Adversarial corpus sourcing.** Fuzz corpora and the injection corpus are ours to
   generate. Whether a curated public corpus is also used (and how its provenance is
   recorded) is undecided.
10. **Budget baselines per platform.** Budgets are stated for one unspecified machine
    shape. Whether the baseline is normalized (per-core, or expressed as a ratio to a
    reference step) so one number serves all supported platforms is undecided.
11. **Coverage measurement for L1/L2.** Branch coverage is a useful signal but not a
    proof of behavior. Whether a coverage floor is a merge gate, and which toolchain
    computes it deterministically across platforms, is undecided.
12. **Determinism of the harness itself.** A test harness that leaks state between
    tests (shared caches, global registries, a shared temp root) undermines every
    claim above. Whether an explicit per-test isolation assertion (fresh state dir, no
    inherited handles) is required at L1 is undecided.
