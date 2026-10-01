# Acceptance model

## Purpose and scope

Architecture is the approved target blueprint. This document defines evidence and release acceptance independently of delivery status. No passing fixture, source file, worker receipt or benchmark description promotes an unimplemented feature. Product usability scenarios are in scope; preferences inferred from anecdotes require validation.

## Evidence layers

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
  once per *refusal* path in `ARCH/security/SECURITY-MODEL.md` §Failure modes.
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
  proven only by the mechanism named in the record (`DEC-026`, `DEC-027`,
  `REQ-GUARD-004`). "Network off" in a profile is the request, never the evidence.
- Audit verification proves modification of already-anchored history is detected. It
  does not prove content authenticity, does not detect fabrication by a principal
  with write access, and does not cover the unanchored tail (`REQ-AUDIT-007`).

## Determinism and flake handling

**Deterministic L1/L2 substrate.** Unit/contract fixtures inject the dependencies below. L3–L5 intentionally exercise real isolated processes, filesystems and platform confinement, recording the actual environment; real-platform results are not portable mock evidence.

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

- **Default CI mock provider transports.** A deterministic scripted transport returns a
  recorded request/response sequence; it can inject a typed overflow, a rate-limit
  hint, a malformed frame, and a pre-content interruption.
- **Default CI loopback servers.** Any test that needs a socket binds `127.0.0.1`/`::1` on
  an ephemeral port. A helper wraps the HTTP client so an attempted connection to a
  non-loopback destination **fails the test loudly** rather than reaching the internet.
- **No live model in default CI; separately authorized isolated live acceptance only.** Default CI does not require an API key, external route or real account. Separately authorized isolated live acceptance may exercise its named route. Provider-specific behavior is asserted through adapter conformance
  fixtures recorded from the wire format, marked with the date they were captured.

**Determinism rules.**

- No wall-clock timestamps in assertions. Where a timestamp is part of the record,
  assert ordering and monotonicity, or use the frozen clock.
- No dependence on hash-map iteration order, filesystem enumeration order, thread
  scheduling, or `PATH` ordering. Any place that needs a deterministic order declares a
  total order explicitly.
- No dependence on locale, timezone, or `TZ`.
- L1/L2 assertions do not depend on host filesystem, temp-directory location, username or network conditions. L3–L5 record the host dependencies they exercise.
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

## Release gates

A release is blocked unless **all** of these pass and their records are retained.
Gate IDs are `G-1..G-17` (no leading zero). `ARCH/security/SECURITY-MODEL.md`'s threat table also uses a `G-`
prefix with zero padding (`G-01..G-10`); cite those rows as `ARCH/security/SECURITY-MODEL.md` `G-0N`.

| Gate | Requirement |
|---|---|
| `G-1` | `ACC-DEP-01` passes for the exact locked all-feature dependency graph, including its disallowed-license negative control; every `Adapt`/`Vendor` entry has a complete in-tree provenance record (`DEC-012`, `docs/research/SOURCE-LEDGER.md` §4). A CI configuration or local pass alone is not release evidence. |
| `G-2` | `THIRD-PARTY-NOTICES` is generated from the resolved dependency graph and shipped with the binary (`DEC-011`, `AX-010`) |
| `G-3` | Full suite green with zero quarantined tests across ≥5 consecutive runs; the determinism-sensitive suites across ≥20 repetitions |
| `G-4` | Containment acceptance (`ACC-P1-01`) passes for **every** supported tier, with a record per tier, and each record **names that tier's `network_guarantee_level`**, its mechanism, and its residual (`DEC-026`); a tier claiming a stronger level than it proves fails |
| `G-5` | `audit verify`, class census, and per-effect ID reconciliation pass on a fresh run and a crash-injection run; the record stores the actual anchoring level and rendered claim boundary (`REQ-AUDIT-001/005/007`, `DEC-031`). An unknown effect or unreachable required anchor blocks release. |
| `G-6` | The headless exit-code contract matches `--help` (`ACC-P1-08`) |
| `G-7` | The session-format and artifact migration chains round-trip exact event/blob references, recover interruption from the authoritative source generation, and refuse a newer stored version |
| `G-8` | Performance budgets are measured with a recorded baseline, or an unmeasured budget is explicitly disclosed and is **not** a P1 exit criterion |
| `G-9` | Product copy makes no unsupported peer comparison; factual provider/model names and required attribution are accurate and provenance-linked (`REQ-VISION-003`, `DEC-011`, `DEC-030`). |
| `G-10` | Fuzz corpus is clean for the current cycle, with no new crash/unbounded-allocation finding |
| `G-11` | Every eval-gated feature that ships has a runnable gate **at the time it shipped** (`DEC-016`); the paired-eval report is retained |
| `G-12` | Every `REQ-*` in a shipped capability has a traceability row naming its evidence, or is explicitly marked unimplemented |
| `G-13` | A long-horizon completion claim has `ACC-H1-01..12` evidence for applicable managed-work features at the exact integrated revision and current specification; worker completion, an isolated-worktree pass, or a PR URL alone does not pass. |
| `G-14` | Every shipped worker/control surface satisfies `REQ-SEC-026` with process-level evidence for its declared backend: a worker cannot invoke control operations, read/write canonical state, mint an operator receipt, or supply caller-authored actor/scope to controller methods; raw ACP identity is not trusted. A backend or adapter without such evidence refuses that execution profile. |
| `G-15` | Session artifacts pass `ACC-P1-09`, segmented event logs pass `ACC-P1-11`, and integrated durability passes `ACC-P1-13` on every supported persistence backend before the product claims durable sessions/runs; `ACC-P1-13A` is the independently runnable primitive gate and is not blocked on `ACC-P1-11`/`13`. `ACC-P1-12` proves read-only inspection cannot mutate or hide canonical history failures. Output truncation passes `ACC-P1-10` for every route that advertises automatic remaining-context recovery. Unknown route semantics remain non-retrying and are not counted as supported recovery. |
| `G-16` | The session-search feature cannot be called shipped/available until `ACC-P1-14` passes at the exact integrated revision; if FTS5 or complete index coverage is unavailable, the UI/CLI reports a typed unavailable/partial result and never claims complete search. |
| `G-17` | `ACC-MOD-01` proves the checked Cargo workspace graph is acyclic and inward-pointing and that forbidden core→adapter/UI/concrete-workspace dependencies fail fixtures. `ACC-MOD-02` proves shipped adapter ports return typed failure receipts and preserve their canonical owner semantics; derived capability views cannot create availability or authority. This gate does not prove runtime authorization or OS confinement (`ARCH/05-MODULARITY.md`, AX-399, AX-412). |

## Definition of done

A capability is done when **all** of the following hold. A capability that fails any
line remains **proposed** if code is absent, **implemented** only where code exists,
and **verified/accepted** only where the corresponding evidence exists. State the
missing gate rather than promoting an absent implementation.

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
10. Residual risks are either mitigated or in the register (`ARCH/security/SECURITY-MODEL.md` §Residual-risk
    register) with a treatment and a review date.

## Evidence retention

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

## Product and usability acceptance

Use representative tasks and participants to evaluate first successful task, blocker understanding, review effort, interruption recovery and confidence in current verification. Evaluate competing design variants and record failures and accessibility limits. Research anecdotes identify hypotheses; they do not establish market fit. Keep build/fixture/participant scope and task-selection limitations with findings.

Local mock-provider, OS fixture and explicitly authorized live-provider evidence are separate. Mock billing/cache/approval cannot prove production behavior. A release has zero quarantined tests under G-3; a future waiver requires an explicit decision and recorded scope. Markdown skills and executable WASM plugins have distinct test gates. Required UX, performance, extension and installation gates cannot be represented by a license-only gate.

## Feature gate applicability

G-1/G-2 concern source provenance/notices only. Applicable UX, product usability, performance, extension, installer, memory, protocol and long-horizon scenarios are required for their shipped capabilities through G-11/G-12 and the relevant feature release criteria. G-17 proves static dependency boundaries and port conformance; it cannot establish runtime authorization or OS confinement. Read-only checks compare content, namespace, mtime and committed heads, excluding and disclosing filesystem atime bookkeeping. Output bounding measures the decision after capture; it is not the duration of an arbitrary subprocess stream.

## Verification settings

Verification settings are schema versioned. Project scope may tighten required checks, never reduce repetitions, disable required layers or skip acceptance rows.

| Key | Meaning | Default |
|---|---|---|
| `verification.layers` | enabled layers | `unit, contract, integration, e2e` |
| `verification.repeat` | full-suite consecutive clean runs required on the merge gate | `5` |
| `verification.repeat_determinism` | repetitions for process/platform-sensitive suites | `20` |
| `verification.timeout_ms.default` | per-test default timeout | `60000` |
| `verification.golden_dir` | committed golden corpus location | repo-relative |
| `verification.evidence_dir` | local evidence root | `<state-dir>/evidence` |
| `verification.perf.baseline` | recorded machine baseline descriptor | required for a budget to be `measured` |
| `verification.quarantine` | per-test quarantine entries with owner + expiry | none permitted at release under G-3 |
| `verification.fuzz.corpora` | committed corpora roots | repo-relative |
| `verification.anchor_required` | fail the gate when the configured audit anchor is unreachable | `true` |

## Evidence production and claim hygiene

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
4. For each sub-check: attempt the escape, record the observed OS-level outcome and the
   specific mechanism evidence, and record whether the violation was audited.
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
release notes) reads the traceability row. It may render `verified` only from a
revision-bound verification record, and `accepted`, `ready`, `contained`, or `audited`
only from the applicable accepted record. An `implemented` row must retain that
weaker label even when its unit tests pass; it cannot be promoted by a worker claim.
Otherwise the surface shows the weaker, true word.

## Verification seams

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
| `CMP-extension-manager` | Port and adapter fixtures, bounded metadata/search, normalized identity/status, stale/deleted state and compatibility evidence. LitePSM owns shared-source ingestion; HorizonCode acceptance verifies the selected adapter consumes a pinned catalog release and does not duplicate its lifecycle. |
| `CMP-config` | Layer merge, schema rejection, project-scope narrowing only, secret-reference enforcement |
| `CMP-analytics` | Ledger/rollup rebuild, observed-vs-estimated, export sanitization |
| `CMP-tui` / `CMP-headless` | Layout stability (no shift on commit), truthful status, `NO_COLOR`/`TERM=dumb`/reduced-motion, exit codes |

## Evidence record schema

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
Status          = proposed | implemented | verified | accepted | blocked
```

`verdict = unmeasured` is a first-class value. It is never rendered as `pass`, and a
requirement whose only evidence is `unmeasured` receives no status promotion; source presence is separately required for implemented, and an acceptance record for accepted.
