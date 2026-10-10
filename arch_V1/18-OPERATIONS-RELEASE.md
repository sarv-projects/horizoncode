# 18. Operations, data lifecycle, performance and release

This contract is written for a local-first product with Windows as the first release
target. It defines the runtime/operational guarantees the design requires; it is not
evidence that any target OS, updater, package, backup or performance budget currently
passes.

## 18.1 State root, process lifetime and location

The user state root is resolved only from trusted installation/user configuration and
validated before launch. On Windows, canonical state stays under the selected Windows
user data root; WSL may execute a worker but is not the storage root. State and
workspace roots are distinct: the state root is owner-private and never mounted into
untrusted worker views. Project/workspace paths are explicit bindings, not inferred
from the process current directory after startup.

OwnerLog and ArtifactStore storage must preserve that privacy boundary: on Unix, create
their state and owner directories owner-only and reject a permissive existing root. OwnerLog
files are owner-readable/writable; ArtifactStore metadata and immutable payload files are
owner-readable only. On Windows, the trusted state-root resolver must validate a user-private
DACL before opening either store; child files inherit that ACL. The current Kernel OwnerLog
and ArtifactStore fail closed with `StoragePermissionsUnavailable` until that validator is
integrated. Target ACL and crash tests remain an acceptance gate, not a Windows security
claim.

Process status vocabulary is precise: `installed`, `discovered`, `launchable`,
`running`, `healthy`, and `available` are separate observations. A catalog/registry
entry is not an installed executable; an installed package is not proof it can be
launched; a launched PID is not a healthy service; healthy is not permitted for a
profile/Run. Every discovery result includes source, timestamp, path identity and
probe result. WSL worker path mappings use explicit Windows↔WSL bindings and preserve
fence/revision identity; no implicit copy of the canonical Windows state root into
WSL.

`hz-kernel` lifetime is controlled by one local supervisor and the durable
supervisor owner epoch. `hz-indexd` is restartable and its derived state is rebuildable.
The host may be an interactive foreground client or supervised app server; detaching
the UI does not terminate managed work while the supervisor remains healthy. If the
kernel/supervisor loses ownership, new managed dispatch is fenced until recovery.

## 18.2 Persistence, durability, projections and disk pressure

Use the approved OwnerLog V2 as the single canonical segmented committed-head store.
This is an explicit new physical format because the historical `horizoncode-eventlog`
source was not recovered; it is not a compatibility claim. Each owner has its own stream
and sequence. Canonical event bytes and required artifacts are durable before the
committed head advances; seals and head digests are validated on replay. SQLite/read
models are rebuildable projections and migration input only; projection deletion must
not delete canonical history. Unknown/legacy log formats are preserved read-only and
refused for writes until a separately verified importer exists.

Run/Effect/Thread owner commands acknowledge only after their required durability
profile is satisfied. Long-horizon runs require the `run_durable` durability contract;
if the platform/filesystem backend cannot provide it, refuse durable managed mode or
label a separately accepted interactive-only profile. Do not weaken durability
silently. Exact durability behavior depends on the active `DurabilityBackend` and
must be validated on target filesystem, crash and power-loss conditions.

No OwnerLog V2 backend is yet accepted for `run_durable`. The historical
`horizoncode-eventlog::StdCommitSink` observation supports that contract only when
compiled for Unix and remains a source-map fact, not the V2 implementation. Windows
directory-entry durability and crash/power-loss recovery have not been accepted.
Therefore Windows-first delivery retains two independent blockers: confined sandboxing
and durable Run storage. Resolve DEC-V1-01 and DEC-V1-17 with platform implementations
and native acceptance records before advertising governed Windows managed Runs.

Canonical event append sequence:

```text
validate owner/state/authorization and bounded schema
→ stage/publish referenced immutable artifacts durably
→ append event bytes
→ synchronize event/segment according to named durability profile
→ publish/synchronize committed head
→ acknowledge receipt/cursor
→ advance rebuildable projection cursor
→ notify subscribers
```

If projection cursor trails committed head, replay from canonical events. If
projection is ahead, its data is corrupt: fence writes, rebuild from canonical stores
and preserve forensic evidence. Torn/uncommitted tail bytes are reported and handled
by the owner-approved repair mode; inspection is read-only. Never silently truncate
or fold uncommitted bytes into replay.

Disk budget reserves a protected control slice for cancellation, effect/worker
reconciliation, minimal audit terminal facts and recovery export. At pressure
thresholds, stop embeddings/index enrichment first, then optional artifacts/analytics,
then new provider Turns/Runs/effectful tools before consuming control reserve. If the
reserve is insufficient, fail closed and surface `DISK_PRESSURE`; no successful
operation is acknowledged without its required durable receipt.

Snapshots/checkpoints are references to exact Thread/Run cursors, RevisionSet,
profile/plugin generations, ContextEpoch and artifact pins. They do not claim to
reverse external effects such as sent messages, opened PRs or remote mutations.
Backup/restore is an owner-consistent snapshot operation with event-head verification,
artifact reachability validation, secret-reference handling, and post-restore
reconciliation; copying an active state directory without the owner lock is not a
valid backup.

## 18.3 Configuration and schema migration

Every persisted configuration/schema has owner, version, canonical encoder/digest,
migration sequence and rollback behavior. Migrations run under a maintenance permit
after a verified backup/checkpoint. They are resumable/idempotent, preserve source
bytes until acceptance, and never make old and new stores writable simultaneously.
Newer unknown major schema refuses the affected service before mutation. Migration
failure leaves the prior generation usable or the service fenced with an exact
diagnostic; no partial config is silently accepted.

Settings migration extends the existing configuration module and the exact §12 typed
contracts, not another resolver. Preserve source bytes/provenance and requested versus
effective snapshots under the §16.6 legacy scope/apply mapping; pending changes and
Run locks survive restart. Migration cannot mark a deferred request effective without
its safe-boundary owner apply receipt.

Public OpenCode Server/API schemas generate public clients. Private Kernel RPC schemas
are separately generated/validated from the private protocol definitions and remain
unavailable to public packages. Generated files are updated by their owner generator,
not edited manually. CI fails if generators produce a diff, if public clients import
private kernel contracts, or if dependency direction violates §13.

## 18.4 Diagnostics and observability

`doctor` is read-only by default and reports:

```text
state-root identity/permissions and available disk reserve
host ↔ kernel protocol/build/peer status and negotiated features
event-log heads/seals, projection cursors and replay/repair state
supervisor owner epoch, outbox claims and unresolved UNKNOWN operations
workspace lease/fence/revision state and orphan process observations
platform sandbox dimensions/backend/residuals, never one green sandbox boolean
provider route/capability metadata without secret bytes
agent adapter installed/discovered/launchable/observed/enforced status
MCP initialization/auth/protocol/toolset generation and availability
context pressure stage/attempt budget/circuit and prompt-too-long recovery outcomes
retry suppression counts/cursors without operation content
memory scope generations, extraction/consolidation backlog and candidate counts
maintenance-lane queue depth/bytes/age, coalescing, supersession and throttle reason
repo generation/parser freshness and backlog priority
composition graph, provider cardinality, generation pins and activation failures
update signature/stage/health/rollback state
```

Repairs are named ActionDescriptors with preconditions, effect class, preview where
applicable and owner receipt. There is no LLM-generated shell repair. `doctor
plugin-graph` shows each plugin/service, provides/requires/optional edges, provider
selection, generation, capabilities, dependents, activation duration and failure
cause.

Metrics distinguish direct vs managed paths and report p50/p95: UI input/paint,
admission→first visible result (excluding remote provider time), provider time to
first token, stream-to-paint, kernel RPC latency, ToolBatch admission, Guard,
ExecutionHost launch, repository query/index freshness, integration/verification,
recovery success and time-to-verified-completion. Usage records preserve source
provenance and estimated/reported distinction. Pricing/cost is accounting and budget
input only, never model selection. Analytics are rebuildable and opt-in/retention
controlled; high-cardinality prompts, repository paths and user content are not
metric labels.

Redacted diagnostics default to metadata, typed error codes, digests, counts and safe
truncated excerpts. Prompt bodies, raw provider responses, credentials, full tool
output and workspace contents require a separately authorized support bundle, shown
to the user before export and redacted with explicit limitations.

## 18.5 Performance targets and measurement contract

These are initial v1 performance targets to validate against the named release
workloads and baseline hardware; they are not measured claims or guarantees:

| Metric | Initial target | Measurement definition |
|---|---:|---|
| Input response | p95 ≤ 50 ms | Key/input event to visible local acknowledgement, warm app, named baseline device/terminal |
| Stream presentation | p95 ≤ 100 ms | Provider chunk arrival at host to rendered text on the surface; excludes provider network latency |
| Animation | ≤ 30 FPS optional ceiling | Decorative animation only; input, cancellation and stream rendering preempt it; idle UI renders on change |

The release record must specify hardware, OS/runtime, terminal dimensions, warm/cold
state, workload, sample count, percentile method and instrumentation overhead. The
TUI should dirty-render and coalesce within frame budget; no whole-screen redraw for
each token. Do not add a model call or kernel round trip per token. Measure p50/p95
first useful result and verified completion separately from provider latency. A
target misses if its test lacks the baseline/environment definition or if its result
is from a mock-only path.

## 18.6 OpenCode upstream and source maintenance

The product is derived from OpenCode; a GitHub fork relationship is not required. Every
release records upstream repository URL, exact source SHA, Horizon patch set, generated artifacts, dependency
lock digests, license/notice inventory and build provenance. Upstream adoption is an
explicit staged change:

1. fetch candidate upstream revision without moving the release pin;
2. compare dependency/package/schema/API and security-sensitive changes;
3. classify local patches as rebase, retain, replace or reject with owner;
4. run generated-client/parity, protocol, direct-turn, UI and security regression
   suites against the candidate;
5. preserve pinned old build and migration/rollback plan;
6. adopt new SHA only through a reviewed change record and release manifest.

Do not blindly merge upstream, merge whole `dev` branches, or copy unreviewed
hook/provider code into a trusted path. Follow the adopted DEC-V1-10 policy in
`17-GOVERNANCE-DECISIONS.md`: no automatic merges; review a candidate at each planned
Horizon release and expedite security-fix review; every Horizon patch has a named module
owner and explicit disposition; generators/toolchains are pinned; and no unowned or
unclassified divergence is accepted. No numeric LOC budget is used because it would
reward or punish code volume rather than patch risk; the complete owned/tested patch
ledger is the budget and is re-reviewed at each candidate. If upstream restructures
Core V2, provider semantics, permissions or TUI lifecycle, adoption must revisit this
architecture seam and its adaptation tests before changing the pin.

Redistribution requires release/legal review of the exact source and bundled assets.
The review records applicable licenses, required notices, attribution and generated
or downloaded assets. No architecture document itself grants a license or proves
notice completeness.

## 18.7 Signed update lifecycle

An update is a guarded maintenance operation:

An explicitly user-started update is attributed to `user_action`; an autonomously
initiated update uses `system_operation` with a durable operation ID and authenticated
updater service principal. This attribution does not grant authority or alter the §14
Guard/effect pipeline.

```text
fetch metadata
→ authenticate metadata against pinned trust root
→ validate target/channel/version/expiry/rollback rules
→ download bounded package
→ verify package digest/signature/provenance
→ stage side-by-side without replacing active binaries
→ acquire maintenance fence and prove no unresolved effect/worker owns mutable state
→ migrate/health-check in isolated staged generation
→ activate atomically at the supported platform boundary
→ verify health and kernel protocol compatibility
→ commit active version receipt; otherwise roll back to last known-good generation
```

No active-binary activation or live schema mutation is allowed while an unresolved
effect or worker owns mutable state. Download, side-by-side staging and read-only
inspection may proceed without changing active state. Fencing and preserving UNKNOWN
work does not settle it and is not an automatic activation exception; admission must
recheck authoritative effect/worker settlement and exclusive maintenance ownership.
An isolated staged-generation migration cannot mutate live schemas. If rollback is
impossible after a schema migration, that migration cannot be included in an automatic
update. Update metadata
key rotation, emergency revocation and offline recovery are explicit release
decisions; until decided, automatic update is unavailable. No downloaded update may
alter plugin trust roots without a separately verified signed policy transition.

## 18.8 Release gates

The following are mandatory before v1 release claims:

1. **Fork/build gate:** clean reproducible build at pinned OpenCode/Horizon revisions;
   dependency and generated artifact digests; license/notice review; CLI/TUI/web/
   desktop entry points launch.
2. **Thread cutover gate:** Core V2 uses only kernel ThreadStoreService for canonical
   reads/writes; migration import/retry/crash fixtures pass; no parallel Session DB
   authority; unresolved legacy work imports UNKNOWN.
3. **Direct path gate:** ordinary request has no Goal/Task overhead; durable admission,
   steer/queue, one provider attempt, whole tool-batch admission, Guarded effects,
   cancellation and reconnect pass on actual host path.
4. **Private IPC gate:** ACL/peer identity, bounded decoder, version mismatch, idempotent
   retry, commit-response-loss reconciliation, owner epoch fencing and resnapshot
   tests pass on Windows first-release transport.
5. **Security/platform gate:** Windows confined backend passes hostile path/process/
   network/reparse/TOCTOU tests before any enforced claim; each supported OS has its
   own acceptance artifact; unsupported dimensions remain unavailable.
6. **Persistence/recovery gate:** committed-head replay, projection rebuild/corruption,
   disk pressure, backup/restore, crash after PREPARED/dispatch/settlement, unknown
   provider acceptance, unknown worker launch and unknown external effect are proven.
   Fixtures cover `turn/operations_reconciled` linked receipts and finite
   `compaction/admitted` accounting before work/crash; cursor bookkeeping cannot reset
   the semantic recovery key or bypass its pinned policy bound.
7. **Managed work gate:** review digest before activation; hard reservation; outbox
   no-duplicate launch; workspace fence; cancellation scope; deterministic integration;
   independent verification; stale Evidence and completion predicate tests pass.
   `run/next_wave_started`, exhausted `task/execution_failed`, pending cancellation
   with UNKNOWN effects and exact verification-policy binding have positive/negative
   fixtures. Direct Thread/Turn budgets and delegation need no fabricated managed IDs;
   Attempt-scoped `maxTurns` survives WorkerExecutionId replacement and new Attempts
   do not reset aggregate budgets.
8. **Extension gate:** untrusted plugin/MCP/agent attempts cannot mutate kernel state,
   obtain undeclared credentials/capabilities or bypass Guard; lifecycle drain,
   quarantine, generation pin and unsupported compatibility behavior are tested.
9. **Product gate:** routes/commands/settings/keyboard/accessibility/reconnect and
   truthful status pass on TUI and applicable web/desktop surfaces; no console/runtime
   errors in exercised flows; drafts/focus survive background events/resizes.
10. **Operations gate:** diagnostics, schema migration, data retention/deletion, key
     rotation/recovery and user export are tested with their documented
     threat/residuals. If automatic update is enabled, signed update/rollback and
     revocation are also accepted; otherwise distribution is manual and verified.
     Update fixtures reject activation/live-schema mutation during unresolved mutable
     work (including fenced UNKNOWN), permit bounded staging/read-only inspection,
     and recheck settlement before activation. DEC-V1-12 signing remains unresolved
     until its own decision/evidence gate is satisfied.

No gate is checked merely because this architecture specifies it. Readiness status
must distinguish `unverified` (proof absent), `available` (current capability exposed),
`verified` (repeatable tests on the exact build/platform), and `accepted` (the applicable
revision-bound release acceptance record). Verification is not acceptance; no static
package catalog or unit-only proof is platform acceptance. Report the source/build,
specification version, platform/backend, fixtures, commands and result supporting each
verification or acceptance claim.
