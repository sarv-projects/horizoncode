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

Large tool/process output becomes bounded artifacts with truthful FULL/SAMPLE/FAILED fidelity.

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

Source readability or a top-level MIT/Apache marker is not full redistribution clearance.

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
- final product UX smoke on TUI and applicable desktop/web.

Release status belongs in HANDOFF/release evidence, not this contract.

## 18.16 Reproducible checkout and package naming

Use horizoncode as the planned npm publication and CLI name; hzcode may be an alias. Do not expose an untested stub as a published CLI. Keep vendor package identifiers until dependencies, build outputs, licensing and migration tests are verified.
The tracked opencode/ snapshot is a pinned source. scripts/architecture/bootstrap_source.py --check reports missing files without mutation; --apply creates missing files only and never overwrites a HorizonCode overlay. Relative source symlinks must resolve within the pinned snapshot.
Fresh clone acceptance: check status, inspect bootstrap plan, apply in the fresh clone, install pinned dependencies, compile/run targeted tests, verify no secret files were staged and check the resulting package. The former pre-push ran all 36 upstream packages and timed out. The focused push gate (scripts/architecture/run_push_gate.sh) now checks Core TypeScript, actual Rust Guard and denial tests, source bootstrap and architecture contracts. Its live result was exit 0. The full workspace Turbo typecheck is still mandatory separately through scripts/architecture/run_full_gate.sh and the PR/manual GitHub Actions workflow. A timeout or a local push-gate pass does not establish release readiness.

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
  ownerEpoch: string; requested: ResourceLimitV1[]; expiresAt: string;
  actualUsageRef?: string; status: "RESERVED" | "ACTIVE" | "RELEASED" | "EXPIRED";
};
~~~

**Admission calculation:** gather total memory available from the actual effective boundary: cgroup v2 (Linux), Job Object quota/commit (Windows), task/application limits (macOS) or explicitly configured user cap. Distinguish physical available, current process resident, reservations, shared cache bytes and GPU memory; do not add Linux RSS across shared mappings and represent shared daemon PSS once globally. Define `remaining(d) = hardLimit(d) - measuredUsage(d) - unconsumedReservations(d) - safetyReserve(d)`, all in the same unit. `unconsumedReservations` includes RESERVED worker capacity not yet reflected in the measurement **plus** any measured active worker's reserved headroom *above* its already-attributed measured usage, never its full reservation again. Bind the measurement and reservation to the same owner/process generation and use one consistent sampling epoch; use saturating integer arithmetic with a signed-safe comparison, never wrap unsigned subtraction. Include OS processes/caches already present in `measuredUsage` **once**, and avoid counting model VRAM as CPU RAM. Stale or unmatched process measurements must conservatively retain outstanding reservation capacity instead of silently freeing it; any missing hard-limit input causes an explicit `UNKNOWN_CAPACITY` decision (queue new costly work or require a bounded conservative operator profile), **not an infinite quota**. Canonical security/permission checks run independently before launch; budget admission is an additional constraint, never Guard bypass.

**Initial scheduling defaults, before calibrated benchmarks:** foreground input and cancellation have priority over derived cache rebuilds; no more than one new heavy build/index/model load may start at once for the same workspace by default; 20 Sessions in the acceptance harness is a **load scenario**, not a default fan-out setting. Numeric per-machine RAM thresholds and regression caps become normative only after §18.17 raw baselines. Do not hardcode JCode's PSS as a target.

**Pressure machine:** `NORMAL → SOFT_PRESSURE → HARD_PRESSURE → RECOVERING → NORMAL` with hysteresis. Soft pressure (measured use >= configured soft cap, or OS-reported pressure) evicts rebuildable caches by least-recently-used bounded family, suspends background/prewarm/index warming and reduces *new* parallel admissions. Hard pressure (hard cap/reservations would be exceeded) rejects or queues new expensive workers, pauses only safely checkpointable managed tasks, preserves interactive cancellation and receipt settlement, and reports the exact blocked dimension. Continue running owned processes unless user/effect policy explicitly authorizes safe cancellation; never kill foreign processes, unsafely terminate partially executing effects, or delete unowned/dirty worktrees. Recovery requires sustained readings below lower watermark and new owner-epoch validation before admission resumes.

**Cache registry and eviction:** one canonical runtime cache owner table keyed by `{family,principal,workspace,sourceGeneration,buildVersion}`. Each cache reports allocated bytes, count, max bytes, TTL, last-used observation, protection class and evict callback. Evict derived read-only data and replaceable UI paints first; then optional immutable index generations not pinned to live request; never evict an in-use generation until consumers release their pin. Provider history is not duplicated as a cache of canonical messages with independent mutation. Canonical OwnerLog, effect receipts, accepted criteria and user edits are **not evictable**. Cache eviction that cannot prove safe releases reports blocked, and must not fabricate freed memory until post-eviction measurement.

**OS sampling:** include wall-clock + monotonic sample sequence, process start fingerprint, full descendant scope and confidence; PSS may require slower /proc access and is never sampled on the keystroke/UI thread. Unavailable platform metrics stay UNKNOWN; enforce only actually supported OS/process isolation. Detect child escaping descendant tree as degraded containment, revoke future work and record unsupported guarantee. Disk pressure can limit *new* build output but must not garbage-collect live Cargo targets, untracked user builds or historical artifacts automatically.

**Lifecycle and telemetry:** reserve with owner epoch → claim worker startup lease → charge measured active usage → reconcile on crash/timeout → release only on confirmed process-tree termination; bounded ephemeral snapshots may expire independently. Aggregations must show agent-only vs all-inclusive local model, actual vs estimated, per-worker vs whole system, and not double-count shared services. Export is local/redacted by default and must survive model-provider and UI disconnections.

**Release fixtures:** cgroup memory cap, Windows Job Object hard memory/process cap, macOS task footprint, 10/20 Sessions, duplicate shared-daemon accounting, PID reuse, orphan child, denial when insufficient disk/FD, user source/cache preservation, peak build output, slow sampler, different model inference load, hysteresis flapping and cache protection. §32.33 enumerates exact fault acceptance.

## 18.19 Build, package and benchmark-output hygiene for multi-agent development

**Current checkout truth:** `opencode/` tracks pinned source, root `packages/` uses overlay + bootstrap hydration; generated package artifacts may accumulate outside Git. Before any compilation check git worktrees, currently active processes, disk capacity, workspace package lock and build directory owners. The cleanup actor must identify only outputs it created and that no live worker still uses; it may never execute generic `git clean`, `cargo clean`, delete `node_modules`/global caches, or remove user-owned worktrees to improve benchmark numbers.

**Build resource budget:** all child processes (Cargo/rustc, Bun/TS, LSP, framework bundler, browser launcher, test executors) are under a bounded process/FD/memory/disk capacity profile (§18.18) and can be paused **before next admission** on resource pressure. Concurrent Rust builds must use compatible shared target roots or a known bounded isolated target per trust/worktree; do not create a full duplicate target per read-only helper. Keep compilation cache hit/miss/size and incremental invalidation measurements separate from runtime PSS. Source edit verification includes a fresh bootstrap/overlay audit, targeted package compile/test, cross-language contract compile, whole monorepo typecheck and platform-specific smoke.

**Output lifecycle:** register artifact/build-output directory + creation owner + expected lease + TTL/fidelity + last read/active process ref; only mark DISPOSABLE after worker teardown, current evidence/release refs preserved and no dirty user file. Race-safe cleanup revalidates ownership and paths using handle-based resolution, refuses symlink/reparse redirects and reports reclaimed bytes *after* remeasurement. Keep required CI logs/security provenance and stable source hashes. Local/private benchmark snapshots redact prompts, tokens, filesystem paths and credentials.

**Self-development/canary:** use pinned build toolchain and isolated signed/reviewed candidate; no automatic source mutation promoted to active Guard/executor. Canary success requires independent test/verification and explicit user confirmation. Failed build or rollback never corrupts canonical Session/OwnerLog/receipt state. Automatic cleanup may remove only verified disposable canary outputs and associated supervised processes.

**Acceptance:** repeated 20-worker read-only runs do not create 20 heavyweight target trees; existing unrelated build remains untouched; full disk fails gracefully; two editors race with cleanup safely; Windows path and junction semantics respected; memory/PSS benchmark records include compilation and local model processes only when clearly declared.

## 18.20 Release licensing and upstream security-policy reconciliation

**Reviewed source fact (2026-10-15):** `opencode/LICENSE` is MIT-licensed and requires keeping its copyright and permission notice with copies or substantial portions. The reviewed HorizonCode root tree has **no root LICENSE or separate third-party NOTICE**. Neither copying the upstream MIT file verbatim as if it exclusively licensed Horizon-owned work, nor displaying it only in a buried subdirectory, is a verified final redistribution/packaging decision. Choose a legitimate license for Horizon-authored parts, preserve applicable upstream and individual dependency notices in distribution artifacts, and audit incorporated source/assets separately before marking packaging/legal gate PASS.

**Public-document correctness:** root `SECURITY.md` and `CONTRIBUTING.md` must describe *HorizonCode* security disclosure, actual preview sandbox limitations and project contribution process. The originals remain in `opencode/SECURITY.md` and `opencode/CONTRIBUTING.md` as upstream provenance. Verify no public Horizon URL or README directs a security vulnerability to the original OpenCode maintainer's unrelated vulnerability inbox, issue tracker, email or eligibility policy. Private vulnerability reporting availability is a real repository setting, not something documentation may assume enabled.

**Release validation:** fresh installation/upgrade/uninstall and notice inclusion; generated packages, dependency manifest and source pins; supported OS sandbox and effect no-bypass evidence; official security reporting channel tested; no copied private credentials; correct downloadable installer/signing status; total RAM/cold-start benchmark reproducibility. Any unsupported item must remain a named gate and not be represented as a shipped capability. Release checklist §10 and HANDOFF are evidence owners, not this wording alone.
