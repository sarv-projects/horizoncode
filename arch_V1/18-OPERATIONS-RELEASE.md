# 18. Operations, data lifecycle, performance and release

Status: normative operational/release contract.

## 18.1 State roots and ownership

Use platform-appropriate application state/config/cache/log roots.

Separate:
- canonical conversational state in the owning Session backend;
- Rust managed-control/effect state;
- derived indexes/caches;
- artifacts/logs;
- credentials/secret references;
- temporary workers/worktrees.

WSL paths are never silently treated as Windows-native durable storage for a Windows release.

Every owner has one location/migration/backup/cleanup policy.

## 18.2 Durability

Rust durable aggregates use the accepted OwnerLog/storage backend and platform durability profile.

Acknowledge durable commit only after the configured backend's required data/directory synchronization succeeds.

If a platform cannot meet the required durability guarantee, the dependent managed capability is unavailable rather than silently weakened.

OpenCode conversational persistence keeps its own canonical durability semantics.

Derived caches/indexes may be rebuilt and therefore can use weaker persistence if explicitly classified.

## 18.3 Disk pressure

Track separately:
- canonical state;
- artifact/log bytes;
- derived index/cache bytes;
- build outputs;
- worktrees;
- model/runtime caches.

Automatic cleanup is limited to product-owned disposable/cache data with explicit ownership and retention rules.

Never delete:
- dirty worktrees;
- user source;
- canonical Session/Run/effect history;
- unknown/unowned directories;
- credentials.

Large tool/process output becomes bounded artifacts with wire fidelity `full`/`head_tail_sample`/`failed` (displayed as FULL/SAMPLE/FAILED).

## 18.4 Configuration and migration

Every persisted configuration/schema has:
- version;
- deterministic migration;
- validation;
- rollback/backup strategy where destructive;
- unknown-field/version handling;
- scope precedence.

User/project/Session settings preserve requested/effective/source/locked semantics.

Migration never invents credentials, fallback providers or permissions.

## 18.5 Secrets

Credential storage uses OS credential facilities or an explicitly accepted secure backend.

Application state stores references/metadata, not plaintext secret dumps.

Backups/logs/diagnostics must not include raw secrets.

Provider auth paths remain unavailable on a platform until their exact delivery/storage path is accepted.

## 18.6 Diagnostics

Doctor/diagnostics report:
- product/build/source versions;
- provider/model/harness status;
- kernel/protocol readiness;
- capability/backend support;
- platform sandbox dimensions;
- index/LSP/DAP/browser/desktop/REPL health;
- automation executor state;
- disk/cache/worktree/resource pressure;
- recent stable error codes;
- log/artifact refs.

Diagnostics must distinguish unavailable, degraded, stale, unknown and healthy.

## 18.7 Telemetry and analytics

Analytics follows 31:
- measured/estimated/unknown provenance;
- content-free metrics preferred;
- no secret values;
- no remote telemetry unless policy enables it;
- deletion/retention follows the configured privacy policy.

Analytics is not a state owner and cannot change routing/permissions.

## 18.8 Performance release gates

Measure on named reference hardware/OS:
- startup/readiness;
- keystroke/UI latency;
- streaming queue/frame behavior;
- prompt/context compile;
- index/search/LSP;
- Guard/IPC/effect dispatch;
- artifact rendering;
- memory/disk under long sessions;
- worktree/subagent concurrency.

External provider latency is reported separately from Horizon overhead.

A regression beyond accepted budget blocks the affected release claim.

## 18.9 Upstream OpenCode maintenance

OpenCode source remains pinned.

Upgrade procedure:
1. choose exact upstream commit;
2. inspect release/security changes;
3. diff Horizon-owned seams;
4. regenerate upstream-generated files with pinned toolchain;
5. run provider/session/tool/UI parity and Horizon contract/security tests;
6. update provenance only after acceptance.

No automatic dev/main merge.

## 18.10 External dependencies/source reuse

Use 42 for immutable external source pins.

Before distribution:
- license and notices;
- transitive dependency obligations;
- native binary/asset licenses;
- source attribution;
- platform packaging terms.
- imported provider/model metadata source, upstream revision/content digest, retrieval time,
  freshness, redistribution license and required attribution/notice text.

**DEC-V1-11 / DEC-V1-12 user decisions (2026-10-25):** HorizonCode first-party
distribution is selected as MIT. Preserve the pinned OpenCode LICENSE and its
copyright/permission notices as upstream attribution; the HorizonCode root
LICENSE and NOTICE must not imply that OpenCode authored HorizonCode. The
selected first-party grant does not clear third-party dependency/native-asset
obligations: inspect the exact candidate closure and include required notices;
missing or indeterminate licenses remain release blockers. Copyright-holder or
year uncertainty is not resolved by inventing a name/date. Signing policy is
deferred beyond V1; signing, remote installation and automatic updates stay
UNAVAILABLE. Local installer recovery is not a signed update/rollback channel.

Source readability or a top-level MIT/Apache marker is not full redistribution clearance.
Catalog metadata is advisory: release acceptance proves its provenance and honest staleness
projection, not that pricing, model capabilities or endpoints remain current.

## 18.11 Packaging

Release artifacts must be reproducible enough to identify:
- source commit/build revision;
- dependency lockfiles;
- generated artifacts;
- native platform/architecture;
- bundled runtime versions;
- configuration/schema version;
- notices/licenses.

Unsupported optional services do not prevent core package startup; they show unavailable reason.

## 18.12 Signing and updates

Automatic update remains unavailable until signing/update-root/channel/rollback policy is resolved.
Remote artifact installation must verify metadata under the same approved signing trust root and remains unavailable until that policy is resolved.

When enabled:
- signed metadata and artifacts;
- staged download separate from activation;
- version/schema compatibility check;
- no activation while unresolved effects/workers own mutable state unless explicitly safe;
- health check and rollback;
- audit record.

## 18.13 Platform support truth

A platform is supported only for capabilities actually accepted there.

Maintain per-platform matrix for:
- filesystem/process/network containment;
- peer authentication;
- durable storage;
- credential store;
- browser/desktop;
- LSP/DAP;
- REPL;
- terminal graphics;
- package/signing/update.

Do not infer support from compilation alone.

## 18.14 Privacy/retention/deletion

Data classes include:
- conversation;
- managed control/effect/evidence;
- source/index;
- artifacts/logs;
- analytics;
- credentials.

Each class needs configured retention/deletion behavior before numeric or physical-erasure claims.

Legal hold/backup/encryption decisions are release gates where applicable.

## 18.15 Release acceptance

A releasable build requires:
- dependency-ordered implementation gates in 10 complete for claimed scope;
- 32 task/security/performance suites passing for supported platforms;
- no known Guard bypass;
- no unresolved required effect UNKNOWN;
- clean install/upgrade path;
- license/notices packaged;
- capability/status UI truthful;
- no hidden paid route;
- critical recovery/restart tests;
- final CLI/TUI product UX smoke for V1; desktop/web smoke is required only for a later release
  that claims those surfaces.
- V1 provider selection/default and ContextService compiler acceptance on the direct and managed
  prompt paths, including truthful context/token/cost provenance and catalog freshness;
- paired real-model baseline-versus-HorizonCode-harness coding evaluations on identical pinned
  open-weight model revision, task set, budget and environment, with independent outcome checks
  and token/cost/runtime provenance. Premium-provider comparison is a separate authorized run.
  Estimated or published benchmark scores are not guarantees or evidence of HorizonCode uplift.

Release status belongs in HANDOFF/release evidence, not this contract.

## 18.16 Reproducible checkout and package naming

Use horizoncode as the canonical npm publication and CLI name; hzcode is the shipped short command for the same entrypoint (amended 2026-10-18). Do not expose an untested stub as a published CLI. Keep vendor package identifiers until dependencies, build outputs, licensing and migration tests are verified.
The V1 local-binary installer preserves the existing `$HOME/.opencode/bin` location for compatibility while installing the `horizoncode` and `hzcode` command names. Installing a binary does not move or rewrite user configuration/data; configuration migration remains owned by the config runtime and must be verified separately.
The pinned `opencode/` workflow and script snapshot is provenance only. Root overlays for inherited VS Code, GitHub Action, container, and Nix hash publication workflows remain manually-triggered no-ops with an unconditional false job guard and read-only permissions. The first-party package publisher exits before importing or executing upstream publication behavior; the first-party container entrypoint permits local host-architecture builds but rejects `--push`/`PUSH=1` before Docker starts. These overlays must remain Git-visible through exact exceptions; the release inventory blocks if a workflow overlay or direct-entrypoint guard is missing. Do not restore publication or repository-write automation before the §18.10/§18.12 legal and signing gates and exact-candidate acceptance are satisfied.
The local container builder defaults its Dockerfile base-image namespace to `localhost/horizoncode`, matching the preceding locally built image chain; it must not implicitly pull the pinned upstream project's CI images. The distribution audit checks that the five disabled publication overlays, first-party publisher/build guards, and qualification workflow are present and not hidden by Git ignore rules. This is a source inventory only; it does not prove the checked-in changes are committed or the publication workflow is safe to enable.
The tracked opencode/ snapshot is a pinned source. scripts/architecture/bootstrap_source.py --check reports missing files without mutation; --apply creates missing files only and never overwrites a HorizonCode overlay. Relative source symlinks must resolve within the pinned snapshot.
Fresh clone acceptance: check status, inspect bootstrap plan, apply in the fresh clone, install pinned dependencies, compile/run targeted tests, verify no secret files were staged and check the resulting package. The former pre-push ran all 36 upstream packages and timed out. The focused push gate (scripts/architecture/run_push_gate.sh) now checks Core TypeScript, actual Rust Guard and denial tests, source bootstrap and architecture contracts. Its live result was exit 0. The full workspace Turbo typecheck is still mandatory separately through scripts/architecture/run_full_gate.sh and the PR/manual GitHub Actions workflow. A timeout or a local push-gate pass does not establish release readiness.

**P9 candidate manifest source contract (2026-10-21):** the isolated Linux qualification builder emits `release-manifest.json` schema 2 beside the candidate. It binds source commit and source-state digest, pre/post-build cleanliness, `bun.lock` and `kernel/Cargo.lock`, actual Bun/Cargo/rustc versions, host OS/release/architecture, config migration identifiers, the V2 contract-set digest, and a bounded per-file size/SHA-256 inventory for candidate outputs. Symlinked, non-regular or over-limit output trees block manifest creation. The distribution inspector accepts only schema 2 and validates unchanged source-state digest, exact artifact membership, file sizes and hashes, and candidate-binary size. This manifest is provenance evidence only; it does not establish reproducibility, licensing, platform acceptance, signing or release authorization. The qualification workflow keeps its build, reports and summary inside the repository artifact root; it does not write runner summary/environment files. The workflow remains manual/read-only and has not been run on the current candidate.

## 18.17 Whole-product RAM, cache and process regression contract (A-V2-30)

**Performance is part of release acceptance, not a post-release wish.** Establish a reproducible baseline before claiming any numeric benefit. Measure JCode and HorizonCode under the same OS/build, repository, provider/model, prompt/tool sequence and 1/5/10/20 concurrent Sessions; report exact commits/configuration, warm vs cold, with/without local embeddings, idle vs five real turns, 30-minute idle and sustained long-run periods. Do not mix vendor figures, simulated sessions, or different workloads.

- Linux: collect `/proc/<pid>/smaps_rollup` PSS plus RSS, USS/private dirty where available, threads, file descriptors, CPU and process count; sum the complete descendant process tree (host, Rust supervisor(s), shell/build/test, LSP/MCP, REPL, render/index). PSS is share-adjusted, not RSS. On macOS report physical footprint/dirty resident and allocation source; on native Windows use private bytes/working set/commit and Job Object membership. **Do not compare PSS numbers directly to Windows working set.**
- Report local inference/embedding-model resident RAM/VRAM separately and also in a declared all-inclusive system total; differentiate warm model reuse, disabled embeddings, cold loading and remote-only runs. Hardware insufficiency is visible and never triggers unconsented cloud or paid fallback.
- Attribute observations to session, Run/Task/Attempt, worker, cache family, process and user-visible tool; record metric unit, measurement method, observed/estimated/unknown, timestamp and software revision. Account for cache duplication (provider messages vs canonical history, decoded tokens, syntax highlight, Markdown/Mermaid, images, symbol overlays), retained callbacks, event subscriptions and artifact previews.
- Every large cache declares maximum entries **and bytes**, owner, TTL/eviction strategy and transparent drops; tool output is capped and artifactized by reference. Eviction never touches canonical transcripts, accepted specs, unsettled receipts, user work or evidence. Release under process-tree memory pressure by shedding rebuildable caches, declining new workers, and politely reporting blocked work. No global `cargo clean`/unowned cache deletion.
- Track cold CLI time-to-first-frame/input, steady p50/p95 keystroke latency, stream frame scheduling, full-frame repaint causes, network vs local provider delay, leak slope, per-session incremental PSS, peak background CPU, disk/build-output growth and worktree cleanup.
- **Budget adoption:** first check in raw reproducible baseline tables (including variability) under `docs/performance/`; then define per-platform and per-build hard caps plus a regression ratchet in CI. A suggested initial alert is >10% median process-tree PSS regression on the controlled 10-session workload, but **this is not an existing pass/fail gate until a stable baseline is collected and approved**. Sampling/OS metrics that are unavailable remain UNKNOWN, never fabricated zero.
- JCode's published RAM figures and cache caps are *external evidence*, not Horizon targets. Allocator switching, glibc `mallopt`, jemalloc decay/arenas and shared-client pools are experiments requiring before/after allocations, correctness tests and explicit platform gates; do not copy allocator tuning blindly.
- No hidden remote telemetry: diagnostics default local/redacted; export or remote aggregation requires user approval and must not include prompt bodies, secrets or raw tool stdout by default. Profiling artifacts are retained/removed under §18.14.

Test owners are §32.32; scheduler/process integration is §21.10; client drawing and artifact budgets are §31.16. See `docs/performance/README.md` for the non-normative measurement runbook and empty evidence template.

## 18.18 Resource profiles, accounting invariants and deterministic pressure controller

**Resource policy API (design, not shipped):** one per-installation `ResourcePolicyV1`, with optional workspace/user/Run overrides resolved through §16 Settings precedence. It governs foreground host processes, pooled headless workers, LSP/DAP/REPL/browser subprocesses, index/render caches, build/test workers and separately reported local model inference. No manager outside the Rust resource/lease owner may allocate a new effectful worker on the assumption that free RAM exists.

~~~ts
type BudgetDimension = "memoryBytes" | "cpuMillicores" | "processes" | "fds" |
  "diskBytes" | "toolOutputBytes" | "activeWorkers" | "tokens" | "providerCostMicros";
type ResourceLimitV1 = {
  dimension: BudgetDimension;
  soft?: string; hard?: string; // decimal nonnegative exact integers, config validated
  source: "OS_QUOTA" | "USER" | "WORKSPACE" | "RUN" | "SYSTEM_DEFAULT";
  enforcement: "HARD_OS" | "ADMISSION_ONLY" | "OBSERVE_ONLY" | "UNSUPPORTED";
};
type WorkerResourceReservationV1 = {
  reservationId: string; runId?: string; attemptId: string;
  workerExecutionId?: string; processStartIdentityRef?: string;
  ownerEpoch: string; requested: ResourceLimitV1[]; expiresAt: string;
  actualUsageRef?: string;
  status: "PROPOSED" | "RESERVED" | "CLAIMED" | "RELEASE_PENDING" |
    "QUARANTINED" | "RELEASED" | "EXPIRED"; // §11.20 sole transition authority
};
~~~

**Current implementation boundary:** `kernel/src/resource_budget.rs` now contains a **CODE_PRESENT pure integer headroom calculator** (not OS quota discovery, resource leasing, worker launch, capacity enforcement, or measured RAM improvement). It follows this equation and retains full reserve when owner sampling is uncertain. `scripts/architecture/run_push_gate.sh` runs its focused Rust unit tests for JC-RES-012.C–G. This calculator must be supplied only same-dimension, same-epoch and trusted owner-attributed measurements before eventual Rust scheduling integration; `None` effective limit yields `UNKNOWN_CAPACITY`. The service/OS/authorization gates remain DESIGN-only.

**Admission calculation:** gather total memory available from the actual effective boundary: cgroup v2 (Linux), Job Object quota/commit (Windows), task/application limits (macOS) or explicitly configured user cap. Distinguish physical available, current process resident, reservations, shared cache bytes and GPU memory; do not add Linux RSS across shared mappings and represent shared daemon PSS once globally. Define `remaining(d) = hardLimit(d) - measuredUsage(d) - unconsumedReservations(d) - safetyReserve(d)`, all in the same unit. `unconsumedReservations` includes `RESERVED` capacity not yet reflected in measurement **plus** any `CLAIMED`, `RELEASE_PENDING` or `QUARANTINED` worker's reserved headroom *above* its already-attributed measured usage, never its full reservation again. When a worker's measured allocation is unavailable or stale, retain the full unproven reserve conservatively; `PROPOSED` reserves nothing, and terminal `EXPIRED`/`RELEASED` are excluded only after the §11.20 proof/atomic log transition. Bind the measurement and reservation to the same owner/process generation and use one consistent sampling epoch; use saturating integer arithmetic with a signed-safe comparison, never wrap unsigned subtraction. Include OS processes/caches already present in `measuredUsage` **once**, and avoid counting model VRAM as CPU RAM. Stale or unmatched process measurements must conservatively retain outstanding reservation capacity instead of silently freeing it; any missing hard-limit input causes an explicit `UNKNOWN_CAPACITY` decision (queue new costly work or require a bounded conservative operator profile), **not an infinite quota**. Canonical security/permission checks run independently before launch; budget admission is an additional constraint, never Guard bypass.

**Initial scheduling defaults, before calibrated benchmarks:** foreground input and cancellation have priority over derived cache rebuilds; no more than one new heavy build/index/model load may start at once for the same workspace by default; 20 Sessions in the acceptance harness is a **load scenario**, not a default fan-out setting. Numeric per-machine RAM thresholds and regression caps become normative only after §18.17 raw baselines. Do not hardcode JCode's PSS as a target.

**Pressure machine:** `NORMAL → SOFT_PRESSURE → HARD_PRESSURE → RECOVERING → NORMAL` with hysteresis. Soft pressure (measured use >= configured soft cap, or OS-reported pressure) evicts rebuildable caches by least-recently-used bounded family, suspends background/prewarm/index warming and reduces *new* parallel admissions. Hard pressure (hard cap/reservations would be exceeded) rejects or queues new expensive workers, pauses only safely checkpointable managed tasks, preserves interactive cancellation and receipt settlement, and reports the exact blocked dimension. Continue running owned processes unless user/effect policy explicitly authorizes safe cancellation; never kill foreign processes, unsafely terminate partially executing effects, or delete unowned/dirty worktrees. Recovery requires sustained readings below lower watermark and new owner-epoch validation before admission resumes.

**Cache registry and eviction:** one canonical runtime cache owner table keyed by `{family,principal,workspace,sourceGeneration,buildVersion}`. Each cache reports allocated bytes, count, max bytes, TTL, last-used observation, protection class and evict callback. Evict derived read-only data and replaceable UI paints first; then optional immutable index generations not pinned to live request; never evict an in-use generation until consumers release their pin. Provider history is not duplicated as a cache of canonical messages with independent mutation. Canonical OwnerLog, effect receipts, accepted criteria and user edits are **not evictable**. Cache eviction that cannot prove safe releases reports blocked, and must not fabricate freed memory until post-eviction measurement.

**OS sampling:** include wall-clock + monotonic sample sequence, process start fingerprint, full descendant scope and confidence; PSS may require slower /proc access and is never sampled on the keystroke/UI thread. Unavailable platform metrics stay UNKNOWN; enforce only actually supported OS/process isolation. Detect child escaping descendant tree as degraded containment, revoke future work and record unsupported guarantee. Disk pressure can limit *new* build output but must not garbage-collect live Cargo targets, untracked user builds or historical artifacts automatically.

**Lifecycle and telemetry:** follow the exact `PROPOSED → RESERVED → CLAIMED → RELEASE_PENDING → RELEASED` states in §11.20; a truly unlaunched `RESERVED` record may become terminal `EXPIRED`, while uncertain launched work becomes `QUARANTINED` until verified reconciliation. Reserve with owner epoch → claim worker startup lease → charge measured active usage → reconcile on crash/timeout → release only on confirmed process-tree termination **and settled effect receipts**; bounded ephemeral snapshots may expire independently. Aggregations must show agent-only vs all-inclusive local model, actual vs estimated, per-worker vs whole system, and not double-count shared services. Export is local/redacted by default and must survive model-provider and UI disconnections.

**P8 source status (2026-10-20):** the Rust reservation/worktree OwnerLog paths and bounded owner-attributed sampler are present in source; process-local `PressureState::evaluate` and RepoIntel's typed resource-pressure projection are also source-present. Soft and hard pressure both require a `RECOVERING` state between sustained calm and `NORMAL`; the caller-supplied calm history is not durably persisted. The projection only narrows a trusted requested profile to `lightweight` for `SOFT_PRESSURE`, `HARD_PRESSURE`, or `RECOVERING`, and adds no work-start authority. P6 now exposes the canonical Config-owned `ResourcePolicyProjectionV1`, but there is no authenticated P1/P8 ingress that supplies its exact effective limits together with owner-attributed usage; no live pressure decision is therefore available. `CacheRegistryV1` provides a bounded owner/generation-keyed metadata table, pin-aware LRU eviction plans, protected canonical state, and explicit unknown/post-eviction measurements in source. P3 has source-prepared cache-owner events, but there is no authenticated Core/HostKernel cache RPC, no retained RepoIntel generation handle for safe eviction, and no owner result measuring reclaimed bytes (`reclaimedBytes` remains null); registration and callbacks are therefore not wired and the registry is not a live cache service. FAILED/CANCELLED logical children have a typed OwnerLog quarantine transition that retains capacity and the worktree. Source includes a quarantine-specific authenticated root reauthorization event, a proof type restricted to read-only reconciliation, exact target resolution, and P8-only prepare/possible-dispatch/receipt methods for a fresh Guarded Inspect. Root reauthorization mappings are capped at the worker-record bound (2,048). Root SessionLink and child Attempt Session remain distinct: root/worktree checks bind the parent Session, while worker lease and terminal-owner checks bind the child Session; nested ClaimedWorker lineage stays unavailable until its proof carries the Run root Session. A resolver recovers only the exact durable completed Inspect receipt after a lost execute response; pending or UNKNOWN operations remain unavailable. These methods do not reopen the failed Run or release a lease. P1 source exposes the read-only reconciliation Inspect route, but still needs proof that an old Inspect supervisor is no longer live before starting a new operation generation. The separate settlement proof still requires the current terminal snapshot, HostKernel quiescence, settled effects, and exact current Inspect receipt; this path and acceptance remain incomplete. Durable pressure recovery still lacks an architecture-owned OwnerLog retention/compaction contract, so no pressure history is persisted. OS-enforced CPU/memory/FD quotas and RC0 HostRun plus independent-verifier attestation remain unwired or unsupported. This source status is not acceptance evidence: worker fan-out stays disabled, and unsupported guarantees remain unavailable until their platform enforcement and integrated evidence exist.

**P8 pressure-consumer source addendum (2026-10-20):** `ManagedResourcePressureTrackerV1` and `WorkerPoolControl::observe_authenticated_resource_pressure` consume only the exact HostKernel policy pin and a fresh P8 owner-attributed snapshot validated against the current OwnerLog cursor. The opaque memory-pressure result binds the authenticated Attempt/owner epoch, policy revision/digest, sample sequence/time, OwnerLog cursor and measured PSS. Missing/unsupported effective memory policy, unknown/overflowed PSS, stale samples, or owner/policy mismatch produce no signal. The lower watermark and calm-sample count are explicit constructor inputs, but are not fields in the current `ResourcePolicyProjectionV1`; no trusted configuration projection or authenticated ingress currently supplies them. P8 invents neither value, so this tracker cannot be used as a product pressure decision. The process-local tracker table is capped at 2,048 owner scopes, resets on process reopen, and begins in `RECOVERING` until a new sustained-calm window is observed. Entries are reclaimed after the last supporting sample expires under the caller's freshness bound; a returning owner starts a new `RECOVERING` window. It has no durable recovery contract and is not connected to HostKernel ingress or P3's RepoIntel consumer. It does not alter admission, eviction, cancellation or lease settlement. Source fixtures are unrun; pressure remains unavailable in the product until the trusted configuration/ingress and acceptance path exist. Pressure samples now also require strictly increasing sample timestamps as well as sequence numbers; repeated or backdated observations produce no signal.

**P8 evaluation source addendum (2026-10-21; not run):** HUP-005 summary now retains status, failure-stage and accounting by each declared arm, including incomplete work. Fake fixture costs are explicitly `FIXTURE_REPORTED`; they do not claim provider-measured cost. Resource use remains `UNKNOWN`, and RC0's trusted attestation-source list remains empty, so neither fake evaluation nor caller-authored samples can become HUP-001/RC0 evidence. Logical-worker replay is independently durable, but settlement/reconciliation still requires P1's current process/effect quiescence and P2's exact terminal Attempt/final-revision evidence; no capacity or worktree lease may be released from P8-local observations alone. No tests/builds or product evaluation have run.

**P8 repository-local ingestion addendum (2026-10-21; not run):** RC0's caller-supplied
outcome and worker-sampler files are now bounded reads through repository-relative
descriptor handles. Absolute paths outside the checkout, parent traversal, symlinked
components, multiply linked/non-regular files, cross-device directories, size overflow,
and mutation during read are rejected. This is an input hygiene boundary only; the
contents remain untrusted and cannot satisfy HostRun or independent-verifier attestation.
The paired fake evaluator now rejects an arm-order seed different from the frozen
manifest seed, so changing evaluation order requires a new manifest/run digest. These
source changes have authored fixtures only; none has been run.
The fake evaluator also distinguishes stop-before-dispatch from cancellation reported by
an invoked adapter, so pre-dispatch cancellation does not inflate provider invocation or
cost totals. Resume now rejects malformed task/arm rows, duplicate/non-contiguous call
indexes and fake rows whose mode differs from the frozen journal. This is fake-runner
accounting correctness only.

**Cache registry source bound:** the metadata table is capped at 4,096 entries and at 64 concurrent P8 pins per entry; a full pin set rejects new pins rather than growing without bound. P8's non-Clone HostKernel-minted observation DTO now also carries RepoIntel's live owner `pinCount`; any positive value excludes that generation from candidate planning. This is an advisory snapshot only: HostKernel must revalidate the retained Arc's live query-pin count immediately before retirement. RepoIntel's current `entryCount` and `totalAccountedSourceBytes` are global LRU totals, so a per-generation adapter must not store/sum them as per-key counts or bytes; use unavailable per-generation entry count until the owner supplies that meaning. Per-generation `accountedSourceBytes` is retained in a distinct aggregate from measured physical allocation and never contributes to expected freed RAM. The receiver enforces owner-epoch/per-generation sequence and freshness bounds; expired sequence watermarks are reclaimed within the same bound. HostKernel minting, authenticated Core/cache-owner RPC, and the callback/retirement caller remain unwired. A resource sample with no authenticated owned process now reports UNKNOWN rather than measured zero.

**RC0 owner sample source revision:** the Rust P8 projection emits schema version 3 and includes each process-backed worker's exact durable child workspace revision. P8 refuses to produce a lease when that revision is missing; the bounded local RC0 parser retains and validates the digest. This binds observed process attribution to the sampled worker's admitted source generation, but the snapshot remains `NOT_ATTESTED` until P1's live HostKernel and P2's independent verifier evidence are present.

**P8 staged pre-admission source addendum (2026-10-21; unverified):** Rust now exposes
`reserve_managed_pre_admission_target` (Stage A),
`resolve_managed_pre_admission_target_for_candidate` (restart replay by authenticated Attempt
identity and stable idempotency key), and `bind_managed_pre_admission_context_digest` (Stage B).
Stage A stores the exact bounded candidate/worktree reservation without a synthetic
ContextSelection; replay returns the original persisted expiry and target pins and does not
extend or replace them. Stage B binds the actual Rust-validated digest to that same still-RESERVED
lease, appends one `PreAdmissionContextBound` OwnerLog event, replays an identical bind without a
second event, and rejects a changed digest. The stable candidate receipt, stable context-bound
receipt, and current cursor/pool lease proof are distinct values; only the current proof authorizes
an admission action. P1 owns HostKernel DTO/handler integration and P2/P7 own preserving the
prepared request across reserve → compile → bind → admission. No checks have run. Worker fan-out
and any release/settlement path remain gated on P1 process/effect quiescence and P2 terminal
Attempt/final-revision/verifier evidence. Resource pressure lacks approved lower-watermark/calm
policy and authenticated ingress; cache retirement lacks an authenticated owner callback and
measured reclaimed bytes; CPU/memory/FD hard limits and RC0 HostRun/verifier attestation remain
unsupported. These paths stay unavailable.

**Managed usage settlement source addendum:** P8 validates P2's durable usage receipt-chain summary on any settlement proof that releases a VERIFIED worker. The summary must have a bounded nonempty chain, valid cursor/ceiling/chain digests and truthful KNOWN/ESTIMATED/UNKNOWN status fields; P8's settlement and failed-worker reconciliation proof digests bind every summary field. A VERIFIED settlement with no accounting summary remains unavailable. This is source-only and does not override P1 quiescence, final Inspect, settled-effects or P2 independent-verifier requirements.

**P8 follow-up source update (2026-10-20):** HostKernel mints RepoIntel cache observations from an authenticated live RepoRead lease and its retained generation, keeping source-byte accounting separate from physical allocation. The bounded HostKernel-owned registry has a plan/retire/acknowledge composer. Current HostKernel source preserves a shared generation's accounting row until its last matching lease is removed and external `Arc` pins are gone; exact-key retry reuses its generation while conflicting replacement fails. P1 has exclusive write ownership of `kernel/src/host_kernel.rs` while its Guard/protocol work continues; P8 will not edit those shared HostKernel callsites. The composer has no trusted pressure/policy caller and remains uncalled, so product cache eviction is unavailable. A read-only final-Inspect resolver returns a candidate-bound Pending intent or, for Completed only, requires the exact durable clean/no-user-change receipt; its v2 candidate digest includes validated usage accounting, and it cannot dispatch or settle. RC0 worker samples are schema v3 and bind each process-backed worker to its exact durable child workspace revision. These are source changes only. Cache, pressure and worker paths remain unverified; OS-enforced CPU/memory/FD quotas remain unavailable and worker fan-out remains closed.

**P8 source audit (2026-10-20):** the current worker/resource implementation has no further safe P8-only runtime gap. Authenticated pressure observation remains advisory and is not connected to product ingress: `ResourcePolicyProjectionV1` carries effective soft/hard values but not an explicitly trusted memory lower-watermark or calm-sample count. P8 must not derive those hysteresis inputs from the soft/hard limits. CPU, memory, process-count and FD OS quotas remain `UNSUPPORTED`; the process sampler and RC0 projection are bounded observations and do not authorize admission, cancellation, eviction or settlement. RC0 remains `NOT_ATTESTED` pending P1 HostRun and P2 independent-verifier evidence. The shared-generation cache invalidation defect is in P1-owned HostKernel call sites: P8 registry keys are source-generation scoped while HostKernel retains per-request leases. P1 is changing HostKernel to preserve cache accounting until the last exact lease is removed and all external Arc pins are gone, and to reject mismatched same-key replacement. P8 will consume that exact retirement boundary; cache eviction remains untriggered until authenticated pressure policy and the safe callback path are wired. No tests, builds, typechecks, audits, samples or benchmarks were run; this source audit is not acceptance evidence.

**P8 source continuation (2026-10-20; historical, no validation):** The separate logical-worker settlement and worktree-disposition transitions remain independently replayable; the disposition receipt binds the immutable original admission owner epoch and exact P8 OwnerLog cursor, while P1's settlement recovery completes a pending disposition only in that same epoch. Core's strict settlement decoder validates the nested disposition receipt separately from the outer settlement receipt and binds its `settlementReceiptDigest` to the outer receipt. A changed-epoch path still requires fresh authenticated root authority, quiescence and a new Guarded Inspect; it cannot reuse historical Inspect evidence. At that checkpoint, P8 final-Inspect pins did not yet bind the settled verifier identity tuple; the 2026-10-21 update below closes that source gap. OS CPU/memory/process/FD enforcement remains unsupported; RC0 remains `NOT_ATTESTED` without P1 HostRun and P2 independent-verifier evidence. Worker fan-out stays disabled. This source review is not acceptance evidence.

**P8 verifier-pin settlement source update (2026-10-21; no validation):** `WorkerSettlementProofV1` now accepts only the opaque HostKernel-minted `SettledVerifierChallengeSetPinsV1` for `Verified` settlement and rejects both missing pins on success and extra pins on failure/cancellation. P8 checks Goal/Run/Task/Attempt and exact committed evidence-digest correspondence, and binds `verificationRunID`, `setIdentityDigest`, `challengeSetDigest`, and evidence identity into the settlement proof digest. OwnerLog settlement schema v4 persists the three verifier pins and includes them in the durable receipt digest; strict decode accepts only the complete pin tuple for a fresh successful settlement and rejects it on reconciliation. Historical schema v1-v3 records remain decodable. At this checkpoint, HostKernel token construction and replay comparison were still pending; the subsequent final-Inspect verifier-pin update below records their source integration. P2/Core still owns strict response consumption. This is source-only, not acceptance evidence. No tests, builds, typechecks, audits or benchmarks were run. OS-enforced limits remain unavailable, resource pressure has no approved authenticated threshold projection, cache retirement has no wired safe callback, RC0 has no P1/P2 attestation, and worker fan-out remains disabled.

**P8 final-Inspect verifier-pin source update (2026-10-21; no validation):** the P8 OwnerLog candidate pin and digest bind the exact `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest` together with the Attempt/evidence/final-revision candidate. HostKernel now resolves the token from the persisted SETTLED ChallengeSet, verifier journal, accepted SpecVersion, current workspace revision and committed typed evidence; all final-Inspect prepare, replay, receipt and successful terminal-recovery callsites pass that opaque `SettledVerifierChallengeSetPinsV1` to P8. HostKernel also compares the P8 settlement receipt's three verifier identities with its retained token before accepting settlement. P8 rechecks Goal/Run/Task/Attempt/evidence equality on preparation, receipt replay and successful terminal recovery. Legacy eight-field candidate-pin events remain decodable without verifier pins but cannot satisfy current receipt recovery or settlement. Source wiring is now present, but the flow remains unavailable pending compile and integrated acceptance. FAILED/CANCELLED paths carry no verifier pins and remain quarantine-only. No tests, builds, typechecks, audits or benchmarks were run.

**P8 READY_TASK reservation-target source update (2026-10-21; no validation):** `WorkerPoolControl::reserve_managed_ready_task_with_target` now combines the exact typed candidate-pin reservation with resolution of its P8-registered, guarded-Create worktree target from the resulting opaque RESERVED lease proof. The helper intentionally retains the durable reservation if target resolution fails; it does not roll back, create a managed Attempt, attach a binding, claim a worker, or authorize dispatch. P8's internal reservation and target resolvers are CODE_PRESENT; the target is not yet WIRED into the authenticated `managed_next_schedulable_task` READY_TASK response. P1 owns that HostKernel scheduler hunk: it must build pins from the authenticated current Task/Spec/profile/context/Guard/resource/root facts, recheck the same Task revision and root authority, invoke this helper, and serialize the target beside that exact candidate. Core must not reconstruct it from the root `workspaceRef`; any failure after reservation must retain the reservation for exact no-dispatch reconciliation. Until this projection and P2/P7's frozen sequence-1 preflight are integrated, managed provider dispatch and worker fan-out stay disabled. The rest of P8's source paths remain CODE_PRESENT but acceptance-blocked: P1 quiescence/Guarded receipt evidence and P2 typed verification/final-revision evidence are required before worker or worktree release; resource pressure/cache retirement lack approved live ingress; OS hard quotas remain unsupported; RC0 remains NOT_ATTESTED without P1 HostRun and P2 verifier attestations. No checks were run.

**P1/P8 pre-admission ordering correction (2026-10-21; supersedes the one-step READY_TASK target projection above):** `managed.pre_admission_target.reserve` accepts an explicit Stage-A typed pin set with `contextSelectionDigest = None`; no synthetic ContextSelection is constructed. P8 reserves the candidate against authenticated Task/Spec/profile/permission/scope/capability/parent/resource/workspace facts, the stable idempotency key and exact P8 worktree locator/deadline. It returns an opaque proof and read-only target with the P8 proof digest and pool revision; it creates no Attempt, binding, claim, effect or provider authority. Core compiles the exact bounded ContextSelection without dispatch on that target. `managed.pre_admission_target.bind_context` appends a `worker_pre_admission_context_bound` event to the same still-RESERVED worker, cloning P8's persisted Stage-A pins and adding only the canonical Rust-validated context digest. `pinsDigest` is the context-free stable candidate identity across A/B; the Stage-B reservation proof digest binds context, current OwnerLog cursor/pool revision and exact lease IDs. Admission consumes that Stage-B proof and attaches DelegationBinding; it never reserves again. A exact replay resolves the existing candidate by Attempt ID plus stable idempotency key and returns the persisted expiry/root/resource/worktree pins (it does not recompute a deadline or reselect a worktree). A changed idempotency key for the same Attempt conflicts; expired/stale reservations require exact no-dispatch reconciliation and a new candidate generation. B exact replay returns the same context-bound pins/proof; a changed context conflicts. A crash after Stage-A append or Stage-B append is recovered by the exact candidate resolver and cannot authorize dispatch by itself. P8 OwnerLog decoder remains compatible with legacy 25-field and 28-field full-pin records; the new explicit staged record shape is decoded strictly. P1 owns HostKernel/protocol; P8 owns staged persistence/resolution; P2/P7 own the exact preflight handoff. No tests/builds/typechecks were run. HostKernel/Core integration remains in progress; dispatch and worker fan-out stay disabled pending integrated acceptance.

**P8 pre-admission replay source correction (2026-10-21; no validation):** Stage-A `proofDigest` is a stable candidate receipt over the persisted context-free pins and immutable worker/ticket/workspace lease IDs. Stage-B exposes a separate stable `contextBoundReceiptDigest` that also binds the actual ContextSelection digest; it remains stable after Attempt attachment and later OwnerLog events. `ReservedPreAdmissionTargetProofV1::lease_proof_digest()` and the `ReservedWorkerLeaseProofV1::proof_digest()` expose the current cursor/pool-bound reservation proof separately. Exact Stage-B replay returns the stored ContextSelection and the same stable bind receipt while refreshing the current cursor; a different digest conflicts. P8's target resolver adds the stable receipt to its projection without treating it as dispatch authority. This removes cursor advancement from response-loss/idempotency comparisons while preserving fresh cursor fencing. P1 must consume the stable Stage-B receipt for request replay and independently validate a current P8 proof before admission. No tests, builds, typechecks or integration checks were run.

**P8 whole-phase source audit (2026-10-21; no validation):** The staged pre-admission OwnerLog path now covers exact Stage-A reservation, target recovery, immutable Stage-B binding, append-loss replay and current-cursor lease revalidation. Existing P8 worker-pool source also covers bounded reservation/claim/settlement, FAILED/CANCELLED quarantine, same-epoch disposition replay, changed-epoch reconciliation with fresh Inspect, and verifier-set identity pins in final-Inspect/settlement receipts. No additional P8-only effectful worker or worktree transition is safe to enable: managed dispatch, verifier settlement and lease release still require P1 Guard/process/effect quiescence and P2 final-revision/terminal evidence acceptance. Resource-policy OS CPU/memory/process/FD limits are unsupported by the active backends; P8 must leave them unavailable. Authenticated pressure samples are bounded and advisory, but a trusted lower-watermark/calm-window projection and policy ingress are absent; OwnerLog retention/compaction for pressure history is also unspecified, so pressure-driven cache retirement/fan-out remains closed. The RepoIntel metadata registry lacks a safe retained-generation retirement callback and measured reclaimed-byte source. `scripts/perf/rc0.py` validates bounded local samples but deliberately keeps them `NOT_ATTESTED`; the HostRun receipt reference and P2 verifier evidence are not yet exposed through one live authenticated RC0 attestation path. `scripts/eval/eval_harness.py` implements only fake HUP-005; real HUP-001/002 launch and score remain gated on trusted HostRun/verifier evidence and explicit selected-route/effect authorization, and no benchmark/provider activity is part of source implementation. These are concrete P1/P2/P3/OS/contract dependencies, not authority P8 can mint locally. No tests, builds, typechecks, audits, benchmark runs or provider calls have been performed; fan-out, pressure eviction and RC0 baseline promotion remain unavailable.

**P8 successful-settlement restart recovery source delta (2026-10-21; no validation):** P8 now has a separate target and Inspect journal path for the crash window after successful logical capacity settlement but before worktree disposition. It requires a new current-epoch authenticated root, same Attempt owner scope, fresh P2 `Succeeded/Verified` terminal with quiescence and settled effects, exact retained P8 registration/lease, and a new current-epoch Guarded Inspect receipt at the terminal revision. The recovery OwnerLog disposition has a separate proof digest bound to the old settlement receipt, immutable admission pins, Attempt/worker, current epoch, current P1 root/Inspect authority and P2 terminal evidence. Historical Inspect cannot satisfy it. The HostKernel ingress and P2 current-terminal projection are not yet wired, so this seam is unavailable and the retained worktree remains quarantined until those owners integrate it. P8 does not release a dirty, user-modified, unknown, or revision-mismatched workspace. No tests/builds/typechecks/audits were run.

**RC0 bounded-input source update (2026-10-20; no validation):** capture now rejects more than 20 Session identities, bounds Session IDs to 128 UTF-8 bytes, bounds the caller-supplied outcome map to 1 MiB/20 Sessions, rejects duplicate JSON properties, orders the selected 1/5/10/20 cohort lexically for repeatable selection, and refuses to write a per-invocation JSONL payload over 64 MiB. These checks constrain caller-controlled ingestion/output only; outcomes and owner snapshots remain untrusted, and no baseline is promoted or attested by these changes. HUP-001..006 still describe evaluation acceptance rather than a shipped paired-runner. Tests were added but intentionally not run under the current implementation-first hold.

**P8 successful settlement source correction (2026-10-21; no validation):** the opaque verified-settlement proof, P8 live settlement validator, terminal Inspect recovery resolver, and replay of new verifier-pinned settlement events now all require the exact final Inspect to be `CLEAN` or `DIRTY_OWNED`, with no user-owned changes, `owned=true`, and `noFollow=true`. `DIRTY_UNATTRIBUTED`, user-owned changes, MISSING, UNKNOWN, and incomplete ownership evidence reject successful settlement. Failed/cancelled recovery remains quarantined and does not reuse the worktree. This closes a source acceptance gap only; it is not test or end-to-end evidence, and P1/P2 still own the independent quiescence, effect, verifier and current-revision proofs.

**Release fixtures:** cgroup memory cap, Windows Job Object hard memory/process cap, macOS task footprint, 10/20 Sessions, duplicate shared-daemon accounting, PID reuse, orphan child, denial when insufficient disk/FD, user source/cache preservation, peak build output, slow sampler, different model inference load, hysteresis flapping and cache protection. §32.33 enumerates exact fault acceptance.

## 18.19 Build, package and benchmark-output hygiene for multi-agent development

**Current checkout truth:** `opencode/` tracks pinned source, root `packages/` uses overlay + bootstrap hydration; generated package artifacts may accumulate outside Git. Before any compilation check git worktrees, currently active processes, disk capacity, workspace package lock and build directory owners. The cleanup actor must identify only outputs it created and that no live worker still uses; it may never execute generic `git clean`, `cargo clean`, delete `node_modules`/global caches, or remove user-owned worktrees to improve benchmark numbers.

**Build resource budget:** all child processes (Cargo/rustc, Bun/TS, LSP, framework bundler, browser launcher, test executors) are under a bounded process/FD/memory/disk capacity profile (§18.18) and can be paused **before next admission** on resource pressure. Concurrent Rust builds must use compatible shared target roots or a known bounded isolated target per trust/worktree; do not create a full duplicate target per read-only helper. Keep compilation cache hit/miss/size and incremental invalidation measurements separate from runtime PSS. Source edit verification includes a fresh bootstrap/overlay audit, targeted package compile/test, cross-language contract compile, whole monorepo typecheck and platform-specific smoke.

**Output lifecycle:** register artifact/build-output directory + creation owner + expected lease + TTL/fidelity + last read/active process ref; only mark DISPOSABLE after worker teardown, current evidence/release refs preserved and no dirty user file. Race-safe cleanup revalidates ownership and paths using handle-based resolution, refuses symlink/reparse redirects and reports reclaimed bytes *after* remeasurement. Keep required CI logs/security provenance and stable source hashes. Local/private benchmark snapshots redact prompts, tokens, filesystem paths and credentials.

**Self-development/canary:** use pinned build toolchain and isolated signed/reviewed candidate; no automatic source mutation promoted to active Guard/executor. Canary success requires independent test/verification and explicit user confirmation. Failed build or rollback never corrupts canonical Session/OwnerLog/receipt state. Automatic cleanup may remove only verified disposable canary outputs and associated supervised processes.

**Acceptance:** repeated 20-worker read-only runs do not create 20 heavyweight target trees; existing unrelated build remains untouched; full disk fails gracefully; two editors race with cleanup safely; Windows path and junction semantics respected; memory/PSS benchmark records include compilation and local model processes only when clearly declared.

## 18.20 Release licensing and upstream security-policy reconciliation

**Reviewed source fact (2026-10-15):** `opencode/LICENSE` is MIT-licensed and requires keeping its copyright and permission notice with copies or substantial portions. The reviewed HorizonCode root tree has **no root LICENSE or separate third-party NOTICE**. Earlier root `package.json` misleadingly declared `"license": "MIT"` despite the missing HorizonCode grant; the private root workspace is now explicitly `"license": "UNLICENSED"` pending an authorized release-license decision. This is **not** a change to the independently MIT-licensed pinned `opencode/` source, nor a final permission policy for Horizon-authored code. Neither copying the upstream MIT file verbatim as if it exclusively licensed Horizon-owned work, nor displaying it only in a buried subdirectory, is a verified final redistribution/packaging decision. Choose a legitimate license for Horizon-authored parts, preserve applicable upstream and individual dependency notices in distribution artifacts, and audit incorporated source/assets separately before marking packaging/legal gate PASS.

**Public-document correctness:** root `SECURITY.md` and `CONTRIBUTING.md` must describe *HorizonCode* security disclosure, actual preview sandbox limitations and project contribution process. The originals remain in `opencode/SECURITY.md` and `opencode/CONTRIBUTING.md` as upstream provenance. Verify no public Horizon URL or README directs a security vulnerability to the original OpenCode maintainer's unrelated vulnerability inbox, issue tracker, email or eligibility policy. Private vulnerability reporting availability is a real repository setting, not something documentation may assume enabled.

**Release validation:** fresh installation/upgrade/uninstall and notice inclusion; generated packages, dependency manifest and source pins; supported OS sandbox and effect no-bypass evidence; official security reporting channel tested; no copied private credentials; correct downloadable installer/signing status; total RAM/cold-start benchmark reproducibility. Any unsupported item must remain a named gate and not be represented as a shipped capability. Release checklist §10 and HANDOFF are evidence owners, not this wording alone.
