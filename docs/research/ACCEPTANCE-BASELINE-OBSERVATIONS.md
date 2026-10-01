# Acceptance baseline observations

Historical delivery/configuration questions from original23 are retained here as research; canonical acceptance contracts do not imply implementation. Original source bytes remain archived.

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
   change? `ARCH/core/CONTEXT.md` Open question 5 raises the same item from the design side.
5. **Generalizing `DEC-016`'s sequencing rule.** `DEC-016` fixes "harness before
   gated feature" for compression. This document applies it to every eval-gated
   feature (routing included) as `G-11`. Making that a hard decision rather than a
   documentation practice requires a `DEC-*`; it is flagged, not assumed.
6. **The `verification.*` configuration group.** Proposed here but not yet part of
   `ARCH/core/CONFIG.md`'s key groups. It should be added there (with schema version and
   migration) or explicitly kept out of user configuration and made internal.
7. **TUI acceptance.** A scripted TUI session is the only way to prove
   `REQ-UI-003` (zero layout shift) and the accessibility properties. Whether that
   harness is in scope for P1 or lands with the cockpit in P2 is undecided; the
   `CMP-tui` seam is listed either way.
8. **macOS network-restricted profiles as an acceptance row.** Seatbelt source emits a
   network rule, but the platform row is not accepted until macOS host tests establish
   actual destinations, child inheritance, local IPC, and helper-process behavior. Keep
   the currently reported level/residual conservative and refuse any stronger required
   level (`DEC-037`, `ACC-P1-01`).
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


Original follow-on phase declaration:

determinism; checkpoint/rewind round-trip; deterministic merge arbitration given
identical inputs; routing eval-gate evidence (`ARCH/core/PROVIDERS.md` §5). `P3`: worktree lease and
merge under concurrency; task-graph durability across compaction/restart; peer-pool
supervision; declarative skill handling and separately gated executable-plugin confinement. Each is declared here so the evidence path
is agreed before the feature exists, not after.

