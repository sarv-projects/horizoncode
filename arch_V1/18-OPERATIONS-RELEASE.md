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

- Linux: collect \`/proc/<pid>/smaps_rollup\` PSS plus RSS, USS/private dirty where available, threads, file descriptors, CPU and process count; sum the complete descendant process tree (host, Rust supervisor(s), shell/build/test, LSP/MCP, REPL, render/index). PSS is share-adjusted, not RSS. On macOS report physical footprint/dirty resident and allocation source; on native Windows use private bytes/working set/commit and Job Object membership. **Do not compare PSS numbers directly to Windows working set.**
- Report local inference/embedding-model resident RAM/VRAM separately and also in a declared all-inclusive system total; differentiate warm model reuse, disabled embeddings, cold loading and remote-only runs. Hardware insufficiency is visible and never triggers unconsented cloud or paid fallback.
- Attribute observations to session, Run/Task/Attempt, worker, cache family, process and user-visible tool; record metric unit, measurement method, observed/estimated/unknown, timestamp and software revision. Account for cache duplication (provider messages vs canonical history, decoded tokens, syntax highlight, Markdown/Mermaid, images, symbol overlays), retained callbacks, event subscriptions and artifact previews.
- Every large cache declares maximum entries **and bytes**, owner, TTL/eviction strategy and transparent drops; tool output is capped and artifactized by reference. Eviction never touches canonical transcripts, accepted specs, unsettled receipts, user work or evidence. Release under process-tree memory pressure by shedding rebuildable caches, declining new workers, and politely reporting blocked work. No global \`cargo clean\`/unowned cache deletion.
- Track cold CLI time-to-first-frame/input, steady p50/p95 keystroke latency, stream frame scheduling, full-frame repaint causes, network vs local provider delay, leak slope, per-session incremental PSS, peak background CPU, disk/build-output growth and worktree cleanup.
- **Budget adoption:** first check in raw reproducible baseline tables (including variability) under \`docs/performance/\`; then define per-platform and per-build hard caps plus a regression ratchet in CI. A suggested initial alert is >10% median process-tree PSS regression on the controlled 10-session workload, but **this is not an existing pass/fail gate until a stable baseline is collected and approved**. Sampling/OS metrics that are unavailable remain UNKNOWN, never fabricated zero.
- JCode's published RAM figures and cache caps are *external evidence*, not Horizon targets. Allocator switching, glibc \`mallopt\`, jemalloc decay/arenas and shared-client pools are experiments requiring before/after allocations, correctness tests and explicit platform gates; do not copy allocator tuning blindly.
- No hidden remote telemetry: diagnostics default local/redacted; export or remote aggregation requires user approval and must not include prompt bodies, secrets or raw tool stdout by default. Profiling artifacts are retained/removed under §18.14.

Test owners are §32.32; scheduler/process integration is §21.10; client drawing and artifact budgets are §31.16. See \`docs/performance/README.md\` for the non-normative measurement runbook and empty evidence template.
