# Installation and Application Updates

## Requirements and scope

The installer targets user-selected laptops/workstations and self-managed servers
(`DEC-046`). No HorizonCode-hosted account or service is required. The first-party
release repository is `https://github.com/sarv-projects/horizoncode`; only signed
release metadata and artifacts from its configured TUF repository are trusted.
Managed deployments may use a content mirror, but a mirror cannot replace signing
keys or weaken metadata validation.

The requirements are `REQ-UPDATE-001..007` (`DEC-061`). A release being available is not permission
to install it. Interactive TUI startup performs a background check of the selected signed channel and
shows a non-blocking notice; non-interactive/headless launches never check implicitly; installation is a separate, explicit operator decision. The
default channel is `stable`. `preview` may be selected explicitly only while signed
preview targets are published; it is never inferred from an install URL or update feed. No automatic update, downgrade, unsigned hot patch, or remote executable
plugin update is part of this contract.

Provider connector maintenance is a separate input to the release pipeline
(`DEC-076`, `ARCH/core/PROVIDERS.md`). A source monitor tracks pinned OpenCode/Cline provider
connector revisions and prepares reviewable native adapter/fixture changes when
upstream behavior changes. It does not publish or install provider code directly;
updates enter the normal HorizonCode review, build, signing, and explicit install
flow. The running application never downloads or executes upstream provider source.
Catalog metadata refresh remains data-only and does not update adapter code.

## Product, package, and executable names

The product/display name is **HorizonCode** (`DEC-033`). The canonical distribution/package name
is **`hzcode`** for the npm package, crates.io package, and installer/download entry
point. After installation, both `hzcode` and `horizoncode` launch the same versioned
binary and the same app state; `horizoncode` is a compatibility command alias, not a
second product/config root. Help and new examples use `hzcode`; compatibility checks
must prove the alias forwards arguments, signals, exit status, environment, and working
directory unchanged. Installers create `hzcode` as the owned executable and add the
`horizoncode` alias only where the selected install method can manage it safely.

The curl-based installation path must retain the `ARCH/integrations/DISTRIBUTION-AND-UPDATES.md` trust-bootstrap gate. Do
not publish `curl | sh`; download the signed installer/metadata as files, authenticate
the bootstrap trust root using a separately documented platform trust path, verify
before execution, and then install the `hzcode` executable. Until that gate is proven,
the curl path is documented as unavailable rather than presenting HTTPS as signature
verification.

## HLD and ownership

```text
TUI startup / `/upgrade` / `hzcode upgrade`
                        │ typed request
                        ▼
                   CMP-update ───────► TUF client + local install record
                        │                         │
                        │                  verified staged target
                        │ explicit consent + safe boundary
                        ▼
               CMP-orch admission sequencer
          run / direct-turn / worker / maintenance
              canonical streams + cross-process lock
                        │ one-use MaintenancePermit
                        ▼
      same signed binary, restricted activation mode
                        │
              health check / rollback

Release engineering (separate authority):
locked build → test/notice/SBOM/provenance gates → target artifacts
   → offline threshold signing → TUF metadata → publish to release repository
```

`CMP-update` owns the one update state machine, update settings, manifest parsing,
TUF metadata/target verification, download bounds, staging, command/UI results, and
the activation request. The activation helper is a restricted mode of the same shipped
HorizonCode binary (`DEC-002`), launched as a separate child process only where the OS
requires it to replace a running executable; it is not a second distributed runtime.
`CMP-config` stores typed user preferences and source provenance. `CMP-orch` owns the
system-wide run/work admission sequencer; updater code cannot kill or mark a run
complete. The initial contract defers replacement until all Runs are terminal and
all worker/direct-turn permits and effects are settled. `CMP-orch` then owns the
atomic maintenance fence: it closes admission for new runs/work, validates canonical
Run/Thread/control state, and grants a one-use `MaintenancePermit` bound to the
update operation, install identity, controller generation, and current binary digest.
The fence remains held through activation and health check or rollback. If quiescence
cannot be proved, the permit expires, or the controller is unavailable, activation
defers. The helper cannot contact arbitrary URLs, choose targets, or bypass
`CMP-update`.
The command registry and TUI are clients of the same service, never alternate updater
implementations.

The release repository publishes TUF `root`, `timestamp`, `snapshot`, and `targets`
metadata, with delegated channel/platform targets as needed. The TUF threat model
covers signed target identity and repository attacks such as rollback, freeze,
mix-and-match, single-key compromise, and arbitrary artifact installation. The selected TUF library must satisfy license, MSRV, maintained status, supported targets and conformance requirements; selection belongs to release engineering research rather than this contract. TLS,
GitHub asset checksums, and attestations are supplemental transport/provenance
controls, not substitutes for client-side TUF verification. Root-key rotation and
thresholds use an offline signing process and a documented emergency revocation
procedure.

The TUF root bootstrapping path is a release blocker: each initial installer channel
must authenticate its first trusted root through platform package signing, verified
OS code signing, or another separately documented trust path. A root key fetched next
to an installer over the same unauthenticated channel is not a trust bootstrap.
Never publish a `curl | sh` or `irm | iex` installation command.

## Durable records and schemas

All records are local, bounded, versioned, and secret-free. Update metadata is not
written to a run's provider or task state.

```text
InstallRecord {
  install_id, install_method, channel, target_triple,
  manager_name?, canonical_binary_identity, installed_version, binary_digest,
  bootstrap_method, self_update_supported,
  trusted_root_version, updater_schema_version, last_successful_health_check
}

UpdateSnapshot {
  repository_id, metadata_versions{root,timestamp,snapshot,targets},
  expires_at, fetched_at, source_origin, metadata_digest,
  target{version,channel,target_triple,length,digest,signature_ref,
         min_runtime,max_runtime,state_schema_min,state_schema_max,
         release_notes_ref}, freshness
}

UpdateOperation {
  operation_id, install_id, from_version, target_version, target_digest,
  state, operator_action_ref?, maintenance_permit_ref?, stage_path_id,
  started_at, updated_at,
  failure_code?, rollback_result?
}

MaintenancePermit {
  permit_id, operation_id, install_id, controller_generation,
  base_binary_digest, owner_epoch, control_event_seq, expires_at, state
}
```

`MaintenancePermit` is owned by `CMP-orch` and committed to the canonical
`SupervisorControlStream` (`ARCH/execution/ORCHESTRATION.md`, `ARCH/execution/LONG-HORIZON.md`, `DEC-062`). That same sequencer
arbitrates system-wide run starts and all model-driven worker/direct-turn executions;
checking only active Runs would leave an update race with direct interactive work.
`UpdateOperation` stores only its permit reference and updater progress; the
updater must not create a competing source of maintenance truth. Permit expiry blocks
helper use but does not by itself reopen run admission; restart recovery must reconcile
the process, executable digests, and swap result first.

`canonical_binary_identity` is a stable local install identity, not a raw workspace
path sent to the server. `release_notes_ref` is rendered as untrusted text through
the normal safe link policy. No update check uploads session IDs, repository paths,
workspace data, credentials, or usage. Install telemetry is absent by default.

Update states are:

```text
IDLE → CHECKING → CURRENT | UPDATE_AVAILABLE | CHECK_UNAVAILABLE
UPDATE_AVAILABLE → REVIEWED → DOWNLOADING → VERIFIED → STAGED
STAGED → DEFERRED_ACTIVE_RUNS | APPLY_READY
APPLY_READY → APPLYING → HEALTH_CHECK → UPDATED
                                  └────────→ ROLLBACK_REQUIRED → ROLLED_BACK
any verification failure → REFUSED(reason); no executable activation
```

`LATER` returns to `IDLE` while retaining the verified target and next reminder
deadline. `CHECK_UNAVAILABLE` is not “up to date.” Each transition has an idempotent
operation ID and an append-only local update event; filesystem changes are reconciled
against the record after restart. A state projection never claims `UPDATED` until the
new binary starts and reports its expected version/digest.

## Update and install flows

### Supported package entry points

| Method | User command/entry point | Installation contract |
|---|---|---|
| crates.io | `cargo install hzcode` | The published package is named `hzcode`; it supplies canonical `hzcode` and the `horizoncode` compatibility executable from the same release. The crate package metadata, binary target names, notices, and supported platforms are release-gated. |
| npm | `npm install --global hzcode` | Publish one `hzcode` launcher package with OS/architecture-specific payload packages or an equivalent reviewed packaging layout. Do not run a hidden network installer in `postinstall`; package-manager installation must be inspectable and package-owned. Payload signature verification remains required in addition to registry integrity. |
| curl | No one-line `curl | sh` form | Download the signed installer, metadata, and required trust material as separate files; authenticate the bootstrap root through a separately documented platform trust path, verify, then execute the installer. Until this is demonstrably secure for a platform, do not advertise the curl path. |
| signed release archive | Download `hzcode` release target | Verify signed metadata/digest before extraction; stage under the user-owned install root and install `hzcode` plus the compatibility alias where supported. |

All methods record one `install_id`, canonical binary identity, method/manager,
channel, version, target triple, binary digest, and trusted root version. Updating a
manager-owned install goes through that manager; `hzcode upgrade` explains the correct
manager action when self-update is unsupported. `/upgrade` and `hzcode upgrade` share
the same update service and state. Both executable names must report identical version,
state root, settings, provider credentials, and update result.

Install, Later, Details and check commands share the same update action IDs, owner
state and operation receipt. Install consent binds the exact target/version/digest/
channel/install identity and disclosed restart consequences. If the target changes,
obtain fresh consent; a verified earlier target never authorizes arbitrary latest code.
Decline/cancel does not affect running coding work. Paused/nonterminal Runs still
prevent activation in the initial contract. After terminal-work maintenance and update,
environment probe caches are invalidated before any future attempt launch; prior
snapshot references remain immutable. Network check authorization is distinct from
install authorization, and unavailable metadata never renders as up-to-date.

### Startup notification

1. On interactive TUI startup, load the locally trusted TUF root and last verified
   metadata from the install state. Validate local install ownership/method and effective
   update settings. Headless/CLI startup skips network checks unless the user explicitly
   runs an update command.
2. Render any unexpired cached update result immediately. In parallel, if checking is
   enabled and due, request one bounded, cancellable check for the locally selected
   channel (`stable` by default) through mediated egress. Preview is eligible only
   after explicit user selection and while signed preview targets are published. A
   shared lock and single-flight key prevent multiple TUI/CLI processes from
   duplicating refreshes.
3. Verify metadata roles, expiry, monotonic versions, channel/platform compatibility,
   and target identity before presenting an update. Metadata is not allowed to choose
   an executable path, arbitrary URL origin, auth method, command, or migration.
4. Present a non-modal, screen-reader-visible notice with `Install`, `Later`, and
   `Details`. `Details` opens version/channel/size/notes and trust information before
   consent. One explicit `Install` action authorizes bounded download, verification,
   staging, and application at the next safe boundary; do not ask for an unannounced
   second confirmation after download. Verify length, digest, signatures, platform
   code-signing where applicable, state-schema range, and required disk space before
   activation.
5. If a durable Run, worker execution, direct model turn, or effect is active or
   unknown, keep the target staged and show
   `Deferred until safe restart`; do not stop work to install. The original Install
   action already authorizes application after all work is terminal at the next normal
   process exit; do not ask for a second confirmation after download. Recheck active
   Run/work state and atomically acquire the controller's maintenance fence before
   activation; it must prevent a concurrent start or direct turn from racing the
   executable swap. The initial release has no forced-pause or migrate-active-run
   path. A concurrent start that wins the sequencer makes activation return to the
   deferred state; update maintenance never silently pauses it.

### CLI and slash command

| Surface | Contract |
|---|---|
| TUI startup | Background check, non-blocking notice; never launches installer automatically |
| `/upgrade` | Opens the same review and one explicit install-consent flow; command can check, stage, or apply only through `CMP-update` |
| `hzcode upgrade` | Interactive check; if current, report current version; if available, show target and request one operator consent, then stage and apply at a safe boundary |
| `hzcode upgrade --check` | Read-only check with stable machine-readable exit/result semantics; no download or install |
| `hzcode upgrade --channel <stable|preview>` | One-invocation override to a currently published, signed channel; does not change the saved setting or permit downgrade |
| `horizoncode upgrade` | Compatibility alias with exactly the same parser, update state, consent, and safe-boundary behavior as `hzcode upgrade` |
| Headless/worker context | No interactive install; cannot supply trusted operator confirmation or invoke control endpoint. Structured output reports a pending operator action |

The first-party CLI surface is intentionally small and installation-aware:

| Command | Contract |
|---|---|
| `hzcode --version` | Print the running version/build target and, when known, channel, installation method, manager, and self-update support. Never contact the network. |
| `hzcode upgrade --check [--channel <stable|preview>] [--json]` | Read-only signed-metadata check; channel must exist and be signed. JSON is an explicit command result, not startup output. |
| `hzcode upgrade [--channel <stable|preview>]` | Interactive signed update review and one explicit install consent; respects manager ownership and active-run safe boundary. |
| `hzcode install status` | Read-only local install/trust-root/rollback status; no network required. |
| `hzcode install repair` | Repair only a standalone HorizonCode-managed install from its verified known-good target; requires explicit operator action, all Runs terminal and settled direct turns/workers/effects. Package managers handle their own repair. |
| `hzcode uninstall` | Remove only the HorizonCode-managed executable and updater files after explicit confirmation; preserve sessions, workspaces, settings, credentials, and audit history by default. Package managers own managed uninstall. |

Unknown flags, unsupported manager actions, an unrecognized install method, and a
missing bootstrap trust path fail with a typed explanation. There is no unattended
`--yes` install flag in the initial contract. Developer/source builds identify as
unmanaged and direct the user to the source/package-manager workflow rather than
pretending that the TUF self-updater owns them.

`hzcode upgrade` is not an alias for `cargo install` or arbitrary package-manager
commands. For a package-manager-owned installation, it identifies the manager and
prints the exact supported manager action; it does not overwrite the managed binary.
The standalone updater only operates on a HorizonCode-owned installation path with
validated ownership and no symlink/junction retargeting.

### Activation, schema compatibility, and rollback

Downloads and extraction are streaming and size-capped; archive paths, links, file
count, decompressed bytes, and permissions are validated before writes. Stage on the
same filesystem as the managed executable when atomic rename is required. The old
binary remains intact until all checks pass. The restricted helper mode receives a
one-use local operation ID, verified target digest, and controller `MaintenancePermit`,
rechecks the bundle, atomically switches the
executable or version pointer, starts a bounded health check, and restores the prior
binary on failure. Windows must use a separate process of the same signed binary and a
tested replacement protocol; macOS/Linux replacement semantics are accepted per
filesystem/platform, not assumed universal. The distributed artifact remains one
HorizonCode executable per platform; a process split does not introduce a second
runtime or duplicate update policy.

Before applying, inspect the state format and required migration range. Do not migrate
state merely because a new binary is downloaded. Migrations run only at a safe restart
boundary, preserve an immutable backup/recovery generation, and must not make the
prior binary unable to recover the state if rollback is needed. If compatibility or
backup proof is absent, refuse automatic activation and require a versioned migration
plan. Active run snapshots retain their selected provider adapter and route; an app
update can affect only future attempts after restart.

### First install and supported channels

Installation is installation-method aware. The first-party direct channel provides
signed platform packages/bundles and standalone archives with TUF metadata. Platform
package channels use their native signing where available; a Linux standalone
bootstrap must use a separately authenticated trust root. The first release must
publish a support matrix by OS, architecture, libc/runtime, package manager,
installation method, update support, and tested replacement semantics. Unsupported
host/manager combinations fail with actionable instructions rather than copying a
binary to an unknown path.

Prefer native package-manager installations where a supported repository exists;
HorizonCode then reports the manager-specific upgrade/uninstall command and never
overwrites that binary. The direct standalone channel is explicitly marked
self-updatable only when the signed installer embeds the reviewed TUF root and its
own distribution signature is verified through a documented independent bootstrap.
Initial install instructions must offer the exact artifact, OS/architecture, digest,
signature verification steps, and recovery path. Source builds remain available for
developers but are not silently enrolled into automatic signed updates.

Required release engineering scripts are specified under `scripts/release/`:

| Script | Responsibility | Key boundary |
|---|---|---|
| `build-targets.sh` | Build locked, target-specific release artifacts and package manifests | no signing keys; clean, recorded toolchain and target matrix |
| `verify-release.sh` | Verify tests, notices, dependency allowlist, SBOM, artifact sizes/hashes, platform signatures, and provenance attestations | failure blocks signing/publishing |
| `prepare-tuf-metadata.sh` | Generate candidate metadata and validate target paths/lengths/hashes/expiry | outputs unsigned metadata only; no online private key |
| `sign-tuf-metadata.sh` | Human-operated offline threshold signing / root rotation | keys stay outside CI and repository; audit signer and resulting digest |
| `publish-release.sh` | Publish immutable artifacts and signed metadata to the first-party release repository | requires release authorization and valid verified package |
| `smoke-installed-targets.sh` | Install/upgrade/rollback checks on clean supported OS images | isolated disposable fixtures; no production data |

Required Bash/PowerShell convenience wrappers remain release-blocked until
their own trust bootstrap is demonstrated; they may only call the verified installer
and may not implement cryptography, unpack untrusted paths, disable signature checks,
or execute downloaded content directly.

Required user-facing launchers are `scripts/install.sh` and
`scripts/install.ps1`, alongside supported native packages. Each
wrapper must have a pinned release artifact, verify the separately authenticated
installer before launch, validate platform/architecture, and call the same signed
installer API. Neither is a self-updater, package-manager replacement, or trust
bootstrap by itself. Activation uses a restricted mode of the signed HorizonCode
binary, not a separately shipped helper or ad-hoc shell script.

## Settings and user experience

`ARCH/core/CONFIG.md` owns `updates.*`; `/settings updates` shows requested/effective values,
source, lock, last check, cached metadata expiry, install method, current channel,
available version, and whether application is deferred by active work.

```text
updates.check_on_start = true
updates.notify = true
updates.auto_install = false        # fixed security invariant; not user-configurable
updates.channel = "stable"          # or explicitly selected, published "preview"
updates.check_interval = "24h"      # lower bound: no more than one check per interval
updates.timeout = "5s"              # compiled maximum; settings may reduce it
updates.origin = compiled            # may be overridden only by managed policy/mirror
```

The local check interval is a minimum to prevent excessive requests; a user can
always perform a manual check. The CLI `--channel` option is request-scoped; only
`/settings updates` changes the persistent channel preference. Settings may disable periodic checks or notifications,
but cannot change trust keys, force unsigned artifacts, or suppress a verification
failure. Sound follows `ui.sound`; theme colors follow the selected semantic palette;
update state is never communicated by color alone. Suppressing notices does not hide
the version in the explicit command or settings screen.

## Failure and recovery cases

| Condition | Required behavior |
|---|---|
| Offline, DNS/TLS error, timeout, provider/host unavailable | Keep last valid cached snapshot; show stale/unavailable timestamp, not “current”; no startup delay |
| Invalid/expired signature, root rotation gap, rollback/freeze/mix-and-match | Refuse metadata/target and activation; preserve old install; show typed security error and audit it |
| Unknown version/channel/platform/schema | Refuse; do not fall back to “latest” or a different channel |
| Same-version different digest | Refuse and retain incident evidence; immutable target identity violation |
| Partial download, disk full, archive traversal/link, oversize artifact | Delete/quarantine staging only after safe reconciliation; never touch current executable/state |
| Concurrent upgrade commands/processes | OS lock + idempotent operation ID; one writer; second caller observes durable status |
| Package manager owns binary | Explain owner-specific upgrade path; do not mutate it |
| Active Run/worker or uncertain process | Defer; never kill, relaunch, migrate underneath, or overwrite a live worker |
| User declines or later | Retain current install and any verified bounded staging according to retention setting; no repeated prompt until next reminder interval |
| New binary fails to start / health check | Atomically restore known-good binary; do not mark update successful; retain failure and state backup |
| Forward-only state migration cannot be rolled back | Refuse binary rollback claim; require compatible dual-read/write window or verified backup/recovery procedure before rollout |
| Trust root/key suspected compromised | Stop automatic updates, use out-of-band root rotation/revocation procedure, clearly distinguish paused security response from “up to date” |

## Acceptance evidence

`research docs/tests.md` defines the fault,
platform, package-manager, and live-channel matrices. Release readiness requires all
of the following: initial-root bootstrap review; TUF conformance and key-rotation
exercise; metadata/target attack corpus; isolated install and upgrade on every claimed
platform/method; concurrent invocation and kill-at-each-transition recovery; active
run deferral; schema-migration and rollback proof; release artifact/provenance/notices
gate; and acceptance of `/upgrade`, CLI, startup notice, accessibility, and muted
notification flows. An unsigned mock repository can test client plumbing but cannot
establish the production trust path.

## Required wrappers and first-run onboarding (DEC-095)

Installer functions: detect_target, inspect_existing_install, verify_bootstrap,
verify_target, stage_install, activate_atomic, configure_path_opt_in, verify_launch,
rollback_activation, write_install_receipt. Bash and PowerShell wrappers delegate to
the same signed installer; no handwritten cryptography, eval, policy bypass or unsigned
download execution. Parameters: target version/channel, explicit install directory,
dry-run, no-PATH-change and offline verified bundle. Avoid privilege escalation for
user installs; system install is a separate explicit platform path. Do not change
PowerShell execution policy or shell startup files automatically. PATH update shows
exact scoped diff, supports decline, preserves formatting and handles spaces/Unicode.
Concurrent installs lock target; reject wrong OS/arch/libc, symlink target, partial
download, corrupt metadata, stale signatures, disk full and manager-owned overwrite.
Cancellation preserves prior usable install; activation failure uses known-good rollback.
No external installer is published before the bootstrap trust and platform gates pass.

First launch: immediate welcome/prompt -> choose local/provider route or Skip -> secure
credential broker/auth when needed -> show effective permissions and observed confinement
-> optional litePSM Connect -> optional project instruction preview -> Ready. Steps are
skippable/back/cancellable and resumable, except prerequisites for a selected capability.
No network/probe, AGENTS overwrite, marketplace install, telemetry or payment action
occurs merely from launching. Empty/missing provider offers configure or local route;
offline mode retains settings. Project init writes only an approved diff. Existing
sessions open without repeating onboarding. /settings can revisit each step.
Acceptance ACC-INSTALL-02; delivery AX-410.
