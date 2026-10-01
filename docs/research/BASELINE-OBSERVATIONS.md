# Source observations

These observations retain their original revision scope. Inspect HEAD before using them as delivery evidence.

## 13-SANDBOX.md: Implementation status at reviewed source baseline

At baseline `1c7a1c68bab9` (2026-09-27), the Linux backend constructs bubblewrap user,
mount, PID, IPC, UTS, cgroup, and network namespaces; the child mount view binds granted
roots plus a fixed runtime base, masks deny-glob matches, and sets `--die-with-parent`.
The source explicitly states Landlock and seccomp are **not installed** in this slice.
The Linux network statement in `ResolvedProfile.applied` is enforced network-namespace
reach isolation, not a claim that the `connect()` syscall is denied; acceptance for
inherited descriptors, local IPC/host bridges, and all descendant paths is not present
in this audit.

The macOS backend invokes a Seatbelt profile and emits path/network rules, but this host
audit has no macOS execution evidence. The Windows backend returns `Unavailable` for
confined profiles; source permits explicit `full-access` runs bare. That current path
does **not** satisfy the target private-controller boundary: the target must refuse
this mode until a distinct worker identity or isolated VM can exclude state, secrets,
and control IPC. The common `check_path` logic is a caller-side reach gate for
HorizonCode's in-process tools, not a kernel sandbox for the controller and not proof
that a hostile process cannot race path resolution. These source facts do not satisfy
the platform acceptance rows. See `docs/history/architecture/audits/2026-09-30-review.md` F-01..F-05 and `TODO.md` AX-101..AX-105.

## 20-ANALYTICS.md: Source status

The schema and lifecycle below are the **proposed target**, not the current
analytics database contract. At Rust baseline `80400370c7898459f7e7c24642caba9af31379d1`
(2026-09-30), `AnalyticsEvent` is session/turn/step oriented and records
USD-specific `cost_micros_usd`; run/task/attempt attribution, native source
currency, quota provenance, and pinned pricing snapshots are not established by
the present event type. Inspect `crates/horizoncode-analytics/src/event.rs` and
`cost.rs`; delivery remains tracked by AX-109/334. Do not label target fields as
stored or verified until migrations and evidence land.

## 27-COMMANDS-AGENTS-SETTINGS.md: Source baseline and scope

At the 2026-09-28 source snapshot (`23d4ce8`), the repository has a headless CLI and
inbound ACP server, not the planned interactive TUI or an agent orchestration runtime.
The shared typed command registry parses `/usage`, `/insights [--days N]`, and
`/skills [list | show <name>]` in one-shot `-p` prompt mode; the composer-reference
parser recognizes typed `@` namespaces but does not resolve or attach references. An
ACP prompt is not parsed as a slash command. There is no reference resolver, settings UI, agent panel, agent
profile registry, ACP client, agent installer, durable run tree, or shared quota
controller. The actual CLI surfaces are `acp`, `audit verify|replay|census`, and
`analytics stats|export`, plus the options defined in
`crates/horizoncode-cli/src/args.rs`. This distinction is a source fact, not a
statement that the target interface already exists.

The first interactive product contract may keep the terminal-first client, but the
same `CommandService`, `AgentDirectory`, settings API, and `RunController` MUST serve
TUI, headless, and ACP surfaces. UI and protocol adapters do not each invent their
own syntax or state.

Interactive buttons, command-palette entries, slash commands, and shortcuts are
presentation/entry adapters over the same stable action identity and owning typed
service. They MUST NOT create parallel state transitions or different permission
semantics for the same intent. The action catalog supplies labels, help, command and
shortcut metadata, availability, and unavailable reasons to all interactive entry
points. A status/header click invokes the same action as its command or shortcut.
Headless and ACP surfaces expose their own typed invocation/result contracts; they do
not pretend to render TUI controls. iCode's pinned command catalog, composer
suggestions, input bar, header, and status bar are pattern evidence at
`SRC-035`/`U-ICODE-TUI`; HorizonCode uses its own typed registry and action/controller
contract.

## 30-DISTRIBUTION-UPDATES.md: Source status and current implementation gap

Source checked at `cbba87b9c6a33fc6faac31cdef9b38d2aae67243` (2026-09-28): no
`CMP-update`, install/update subcommand, updater helper, package/release workflow, or
`scripts/` directory exists; `crates/horizoncode-cli/src/args.rs` has no `upgrade`
command. `Cargo.toml` has no selected TUF client. These are proposed designs; the
source/acceptance trace is `docs/research/SOURCE-TRACEABILITY.md` `AX-365..366`.

An accepted binary update invalidates cached ExecutionEnvironmentSnapshot probe
results for the new binary/runtime identity. The first managed launch after update
must re-probe and record a fresh snapshot before resuming an Attempt; schema migration
and rollback preserve prior snapshot references and never silently rewrite history
(DEC-089).
