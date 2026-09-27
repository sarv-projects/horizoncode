# 13 — Sandbox (`CMP-sandbox`)

## Purpose

`CMP-sandbox` is the **enforcement layer** for platform confinement and egress. Where
`CMP-guard` decides *whether* an action may run, `CMP-sandbox` applies the requested
reach boundary and reports the guarantee supported by its OS mechanism and acceptance
evidence — filesystem, network, and child processes. Every tier presents **one `SandboxProvider` interface** so
callers never branch on backend (`DEC-008`, `REQ-GUARD-004`).

The module executes the confinement decision owned by `CMP-guard`; it never evaluates
its own policy. If confinement cannot be established, the default is refusal, not
silent unconfined execution.

`CMP-sandbox` is the **sole reach authority**: `check_path` (in-process filesystem
operations) and `spawn` (child processes) are the only two calls that can grant or
bound reach, and every tier enforces the resolved profile through them
(`DEC-024`, `DEC-025`, `REQ-SEC-025`). Authorization is not reach
(`REQ-SEC-010`): a Guard `allow` is a proposal this layer is free to refuse.

## Responsibilities

- Resolve a requested profile into a concrete confinement plan and apply it.
- Scope filesystem **read** and **write** access to the granted roots under policy —
  reads are scoped on **every** tier, not only writes.
- Apply the **network policy** at the tier's **declared guarantee level**
  (`DEC-026`, `REQ-GUARD-004`).
- Refuse a spawn that names an absolute path outside the granted roots, rather than
  relying on the tool plane to have extracted it (`DEC-024`).
- Block child-process network reach and dangerous host bridges (process inspection,
  VM sockets, `io_uring`) only where a concrete backend mechanism can enforce and test
  the restriction; do not describe reach isolation as denial of the `connect()` API.
- Provision and invoke an isolation backend per tier (local / container / remote).
- Keep protected subpaths (e.g. VCS hooks and agent-owned config) read-only even
  inside a writable root.
- Emit a typed result and sandbox-denial records to `CMP-audit`.
- Fail closed when a required backend is unavailable.

**Never owns:** the allow/ask/deny decision (`CMP-guard`), credential custody
(`CMP-secrets`), tool schemas (`CMP-tools`), or provider/model transport
(`CMP-provider`).

## Interfaces

| Peer (`CMP-*`) | Direction | Contract |
|---|---|---|
| `CMP-guard` | inbound | resolved `ConfinementProfile` (fs scope, network policy, protected subpaths) |
| `CMP-tools` | inbound | `run(command, cwd, env, profile, limits) -> SandboxOutcome` for shell/exec; in-process fs ops consult `check_path`. **These two calls are the only enforcement calls** — no other entry point may grant or bound reach (`DEC-024`, `REQ-SEC-025`). |
| `CMP-runner` | inbound | cancellation handle; process trees reaped on cancel |
| `CMP-audit` | outbound | profile-applied, apply-failed, fs-violation, net-violation records |
| `CMP-tui` / `CMP-headless` | outbound | health/status: `ok | degraded | down` with reason |
| `CMP-orch` | outbound | per-subagent isolated worktree scope and limits |

## One `SandboxProvider` interface

```rust
trait SandboxProvider: Send + Sync {
    fn probe(&self) -> Availability;                       // once, at startup
    fn resolve(&self, profile: &ConfinementProfile)
        -> Result<ResolvedProfile, SandboxError>;          // fail-closed on error
    fn spawn(&self, cmd: &Command, p: &ResolvedProfile)
        -> Result<SandboxOutcome, SandboxError>;           // child process  path
    fn check_path(&self, op: FsOp, path: &Path, p: &ResolvedProfile)
        -> Result<(), SandboxError>;                       // in-process fs path
    fn teardown(&self, outcome: &SandboxOutcome);          // mounts, temp state
}
```

Callers hold a resolved profile, not a backend. Backends are selected by tier:

| Tier | Backend | Notes |
|---|---|---|
| Local (default) | Linux: bubblewrap namespaces; Landlock/seccomp are separate optional mechanisms only when linked, installed, applied, and verified · macOS: Seatbelt profile · Windows: AppContainer + restricted token/job objects only when the native backend is linked | `--network=none` is the requested policy; effective guarantee is reported per backend; workspace-write only |
| Container | OCI runtime (Docker/Podman) | Reproducible toolchains; mount-scoped workspace |
| Remote / cloud | Managed sandbox behind the same trait | Hostile or elastic workloads; transport is an adapter detail |

`bubblewrap` is invoked as a subprocess, never linked, keeping the binary's license
surface clean (`DEC-008`, `DEC-012`). Landlock and seccomp bindings are ordinary
permissive dependencies used in-process. The `--network=none` default is a *request*;
what each backend actually enforces is its declared `network_guarantee_level`
(§Network guarantee levels, `DEC-026`).

## Data / state model

```
ConfinementProfile = {
  tier:            local | container | remote,
  filesystem:      read-only | workspace-write | full-access,
  writable_roots:  [Path],
  readable_roots:  [Path],
  protected:       [Path],            // read-only even inside a writable root
  deny:            [Glob],             // must be enforced by the selected backend, not assumed from config
  network:         none | allowlist | full,
  network_rules:   [host:port/protocol],
  limits:          { cpu, memory, disk, wall_clock }
}
ResolvedProfile = { backend, applied_at, mounts[], seccomp_mode, epoch,
                    network_guarantee_level, network_mechanism, network_residual }
SandboxOutcome  = { exit, stdout_ref, stderr_ref, denied?, violations[] }
```

- **Profiles:** `read-only` (write only to session state + temp; network off at the
  tier's declared level), `workspace-write` (default; write to workspace + session +
  temp; network off at the tier's declared level), `full-access` (no fs restriction,
  network allowed — still subject to Guard and the catastrophic gate, and still one
  egress path).
- **Protected subpaths:** VCS metadata/hooks and agent-owned configuration stay
  read-only inside any writable root so a write grant cannot rewrite the policy or
  install a hook that runs outside confinement.
- **Deny globs** are enforced at the selected backend boundary for read, write, and
  rename where supported, so a denied path cannot be read via a tool nor relocated out
  of the deny set and read elsewhere. If a tier cannot enforce that property, it must
  refuse the profile rather than claim kernel enforcement.
- **Reads are scoped to the granted roots on every tier** (`REQ-SEC-025`). This is a
  reach property enforced here, not an authorization the caller performed. Linux
  target design materializes a mount view containing only granted roots; the macOS
  Seatbelt profile's `file-read*` grants MUST be expressed as granted-root subpath
  allows rather than a blanket read; Windows relies on AppContainer ACLs only when
  that backend is linked and exercised. A spawn naming an absolute path outside the
  granted roots is **rejected**, or masked so the target does not exist in the child's
  view. The current source snapshot is narrower; see the dated implementation-status
  note below.
- **`network_guarantee_level`** is the tier's declared level (`enforced` |
  `capability` | `best_effort` | `none`) together with `network_mechanism` and `network_residual`;
  all three are surfaced as `ResolvedProfile.applied` notes wherever a
  network-restricted profile is presented, and recorded in that tier's acceptance
  record (`DEC-026`, `REQ-GUARD-004`, `REQ-VER-014`).
- A denied operation inside a namespace is reported as a **violation**, not a crash.

## Lifecycle & flows

### Once at startup
1. **Probe** each candidate backend for the platform and record availability.
2. Keep the controller/provider process outside a child tool's no-network profile;
   provider and MCP HTTP traffic needs its own mediated egress. Agent-owned file I/O
   uses checked, handle-relative paths; untrusted tool and extension execution runs
   in a separately confined child. A future in-process sandbox may constrain the
   controller only if its provider/broker and dynamic-grant topology is proven.
3. Freeze each **child execution** profile for that process lifetime. A running
   child cannot relax it; a later grant requires a new authorization and a new
   child profile. Resuming a session re-resolves and proves the requested profile
   before any new child effect (`DEC-031`).
4. Child commands are spawned through the tier backend (for example, bubblewrap
   constructs the namespace and filesystem view); any additional filter is represented
   only when the selected binary and kernel actually apply it. All mechanisms derive
   from the same frozen profile.

### Per effect
1. `CMP-tools` receives a Guard `allow` and the resolved profile.
2. In-process fs operations call `check_path` and use a handle-relative/no-follow
   open or rename where available; `check_path` alone is not a kernel boundary or
   a complete TOCTOU defense. Command execution calls `spawn` with a frozen child
   profile. A platform lacking the required safe path primitive refuses the effect.
3. The selected backend applies only mechanisms it can establish: Linux local uses
   bubblewrap namespaces and an isolated network namespace when configured; future
   Landlock/seccomp checks are separate evidence-bearing layers. macOS uses a
   Seatbelt profile. Windows reports unavailable until its native AppContainer/token
   backend is linked. No backend inherits another platform's guarantee by interface
   similarity.
4. Output is bounded and persisted by `CMP-runner`; the model sees a compact view.
5. Denials and violations append to `CMP-audit`; cancellation reaps the process tree.

### Network policy
- Default `none`: the child namespace has no usable network **to the extent the tier
  can prove**. The mechanism differs per tier, so the level it reaches is declared,
  never assumed (§Platform notes, `DEC-026`).
- Network guarantees describe **network reachability**, not denial of a syscall API.
  A Linux target may use a new network namespace to remove ordinary host interfaces
  and routes. That does not prove every local IPC socket, VM bridge, inherited
  descriptor, helper process, or broker is unreachable. Those are separately scoped
  and tested. A seccomp filter may be an additional defense, but this design does not
  claim that denying `connect`/`bind` or restricting socket families is the primary
  proof of network isolation.
- Windows confined execution is currently unavailable; the proposed AppContainer
  capability posture is not a shipped guarantee. macOS emits Seatbelt network rules,
  but no stronger process-tree claim is made until host acceptance covers descendants,
  local sockets and helper processes. Both tiers report their current availability and
  residual; no level is inferred from the platform name.
- **Allowlist** grants specific `host:port` + protocol through the mediated agent
  egress. A child with network access must be forced through an unbypassable broker;
  a broad child network namespace plus an application HTTP check is insufficient.
  If forced mediation is unavailable, that child profile is refused.
- **Process/child-network blocking** applies to every descendant that remains within
  the backend's confinement boundary. Inheritance and escape behavior is a platform
  acceptance question; record the observed descendant boundary instead of assuming
  that a wrapper automatically confines a detached helper.
- **A required level the tier cannot provide is refused (fail closed)**
  (`REQ-GUARD-004`). A caller demanding `enforced` on the macOS or Windows tier gets a
  typed refusal, never a silent downgrade to `best_effort`/`capability`.

## Profile matrix

| Profile | FS read | FS write | Network | Use |
|---|---|---|---|---|
| `read-only` | scoped to granted roots | session state + temp only | off at the tier's declared level | Exploration, review, untrusted analysis |
| `workspace-write` (default) | scoped to granted roots | workspace + session + temp | off at the tier's declared level | Everyday repo work |
| `full-access` | unrestricted | unrestricted | allowed | Explicit, audited user activation only |

`full-access` widens capability but never bypasses Guard: the catastrophic gate and
the single-egress rule still apply.

**"Off" is a per-tier declared level, not a universal claim** (`DEC-026`). The matrix
row says the profile *requests* no network; §Platform notes states what each tier can
actually enforce, and the resolved profile records the level, mechanism, and residual.
A profile whose requested level the tier cannot provide is refused, not approximated.

## Platform notes

Enforcement targets are tiered by **what the platform can actually prove**, not by
product importance. Linux and macOS are the **first enforcement targets**, with
separate acceptance for file reach, network reach, process-tree lifetime, and host
bridge residuals. Windows remains a product target, but its native sandbox is
unavailable in the current source snapshot; it must not be called supported until
that backend is linked and passes its own acceptance suite.

- **Linux (local default, first enforcement target).** The present implementation uses
  bubblewrap namespaces, a scoped mount view, and an unshared network namespace for
  `none`; its source explicitly says Landlock and seccomp are not installed in this
  slice. Therefore network proof is a reachability test against the isolated namespace
  plus probes for inherited descriptors, Unix sockets, host bridges, descendants, and
  helper access. Do not claim syscall filtering. A hard allowlist needs a forced broker
  and an unreachable direct-network path; otherwise refuse allowlist execution. If
  bubblewrap is unavailable, the effect is denied.
- **macOS (first enforcement target).** A Seatbelt-profile backend implements the
  same `SandboxProvider` trait and is an acceptance target for real containment.
  Path containment is kernel-enforced by the Seatbelt profile, and `file-read*` grants
  MUST be issued as granted-root subpath allows rather than a blanket read, so reads
  are scoped to the granted roots like every other tier. Current Seatbelt source
  emits a network-deny rule for the wrapped command, but descendant inheritance,
  broker/socket access, and escape behavior require host acceptance before assigning a
  stronger guarantee. Until then, expose the residual and reject callers demanding
  stronger guarantees.
- **Windows (product target; unavailable in current source snapshot).** Confinement is
  designed to use an
  **AppContainer** boundary plus a **restricted token** and **job objects** for
  process/child containment. Job objects alone govern process lifetime, job-wide
  limits, and child membership — they do **not** by themselves deny filesystem paths
  or outbound network the way Landlock + seccomp do; AppContainer capability plus
  file/registry ACLs carry the path and network part, and those ACLs are what scope
  reads to the granted roots on this tier. This tier therefore has its own
  acceptance tests (`TODO.md` Windows-containment task) and its limits are stated
  honestly rather than described as equivalent. Availability is probed; a requested
  backend that cannot be established fails closed. WSL is an execution backend, not
  the Windows storage root.

### Network guarantee levels (`DEC-026`)

Every tier **declares** the level it provides. `enforced` is a demonstrated OS-level
denial of prohibited network reachability; `capability` means denial by absence of an
OS network capability; `best_effort` is a scoped mechanism with a documented residual;
`none` means no network guarantee. A tier MUST NOT claim a level stronger than it can
prove, and a caller that requires a level the tier does not provide MUST be refused.
`DEC-027` is the formal read-through that makes "network off" a *request* everywhere in
the document set and never a claim about what a tier enforces.

| Tier | Level | Mechanism | Residual |
|---|---|---|---|
| Linux (local) | `enforced` only after acceptance | unshared network namespace plus measured path/descriptor/IPC boundary; optional filter recorded separately | No assertion that `connect()` itself is denied. Probe network namespace reachability, inherited descriptors, local IPC, VM sockets, and descendants. |
| macOS (local) | `best_effort` until acceptance | Seatbelt network rule; report actual process/descendant boundary | No child-inheritance assumption; allowlist unsupported until a forced, unbypassable broker exists. |
| Windows (local) | `none` / unavailable until implemented | Native AppContainer backend is not linked in this snapshot | No capability-denial claim until native setup and outbound tests pass. |
| Container / remote | declared by the tier | the tier's own isolation boundary | Whatever the tier declares is recorded verbatim; the interface is not upgraded by assumption. |

`enforced` is the level a caller must demand for a hard "no egress" claim. The
`best_effort` and `capability` levels are supported, disclosed postures — not
"unsupported" tiers — and the difference is enforced by refusing an unmeetable
requirement rather than by downgrading it silently.

## Failure modes

| Failure | Behavior |
|---|---|
| Backend unavailable | Select another backend only if it satisfies the exact required filesystem/network/process guarantees; otherwise **deny with reason** — never silently downgrade or run unconfined by default |
| Profile cannot be applied | Fail closed; refuse the effect; audited |
| Deny glob cannot be materialized (no backend) | Refuse to start rather than under-enforce |
| Symlinked policy/config path | Refuse (prevents retargeting the policy) |
| Mount preflight unsupported (e.g. `/proc`) | Retry without the optional mount; never drop the filesystem confinement |
| Capabilities retained after setup | Abort the spawn; audited |
| Network denied at runtime | Typed violation returned to the tool; audited |
| Process hang | Watchdog → interrupt/cancel; tree reaped |
| Explicit unconfined mode (policy flag) | Allowed only with audited opt-in; surfaced loudly; never default |

## Configuration

JSONC profile definitions, discovered global → project (nearest wins). A project may
**add** profile names, never redefine a global/enterprise profile.

```jsonc
{
  "sandbox": {
    "profile": "workspace-write",          // read-only | workspace-write | full-access
    "tier": "local",                        // local | container | remote
    "workspace": { "writable": ["**"], "protected": [".git/hooks", ".horizoncode"] },
    "deny": ["**/.env", "**/*.pem", "**/.ssh/**"],
    "network": { "mode": "none" }           // none | allowlist | full
  }
}
```

## Invocation from the tool plane

`CMP-tools` never calls an OS primitive directly. Every effectful tool
(`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `shell`) acquires a Guard
ticket, then routes through `CMP-sandbox`: path operations through `check_path`,
process operations through `spawn`. Egress for `webfetch`/`websearch`/provider
traffic leaves through the single mediated egress path, which is subject to the same
network policy.

## Verification approach

- **Containment tests:** a command cannot read a denied path, cannot read a path
  outside the granted roots, cannot write outside the writable roots, and cannot
  rename a denied path out of the deny set. A spawn naming an absolute path outside
  the granted roots is rejected or masked, asserted per tier.
- **Network tests, per declared level** (`DEC-026`, `ACC-P1-01(d)`): probe external,
  loopback, DNS, IPv6, inherited socket/FD, Unix-socket, VM-socket, child-process, and
  proxy paths. Record syscall policy separately from reachable-path evidence. An
  allowlist passes only when a forced broker is the sole usable egress path and denied
  targets fail under DNS-rebinding and redirect tests.
- **Level/refusal test:** a caller requiring `enforced` on a `best_effort` or
  `capability` tier is refused typed — the run never silently downgrades.
- **Capability test:** after setup, effective/permitted capabilities are empty.
- **Fail-closed tests:** with the backend removed, the effect is denied and audited,
  not run unconfined.
- **Escape tests:** nested namespace rearrangement, VM-socket bridges, and
  synthetic-mount cleanup are exercised; a violation forces a non-zero outcome.
- **Parity:** the same test suite runs against each tier that advertises support.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-GUARD-004` | Sandboxed execution defaults to workspace-scoped writes and a request for no outbound network; each tier declares its `network_guarantee_level` with mechanism and residual, the level is surfaced and recorded, and a required level the tier cannot provide is refused (`DEC-026`, `DEC-027`). |
| `REQ-TOOL-003` | Denied tools are absent via Guard; the sandbox independently confines the rest. |
| `REQ-SEC-003` | This module is the sole path-reach enforcer: in-process operations use `check_path`; spawned tools use the selected OS boundary. The profile is refused when that boundary cannot establish required scope. |
| `REQ-SEC-025` | Sole path-reach owner: scoped roots and deny/protected paths are checked at use and applied by the selected tier. Acceptance records name whether evidence is in-process, mount-view, or kernel policy; a tier that cannot enforce the required boundary refuses the effect (`DEC-024`, `DEC-025`). |
| `REQ-LOOP-005` | Cancellation propagates to process trees; partial state stays inspectable. |
| `REQ-ORCH-003` | Per-subagent writable scopes are non-overlapping worktrees or explicitly merged. |
| `REQ-PERF-001` | Startup probe is bounded; the warm-cache prompt target is unaffected. |

## Implementation status at reviewed source baseline

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
confined profiles; only explicit `full-access` runs bare. The common `check_path` logic
is a caller-side reach gate for HorizonCode's in-process tools, not a kernel sandbox for
the controller and not proof that a hostile process cannot race path resolution. These
source facts do not satisfy the platform acceptance rows. See `ARCH/24` F-01..F-05 and
`TODO.md` AX-101..AX-105.

## Open questions

1. **Windows backend** — the target mechanism (AppContainer + restricted token/job
   objects) is a design option, not shipped support. First prototype the native
   boundary, then pin the exact filesystem, registry, child-process, and network test
   matrix; reject confined execution until that passes (`TODO.md` AX-113).
2. **Once-at-startup vs. per-command wrapping** — confirm the split between the
   process-lifetime in-process confinement and the per-command subprocess view for
   every tool, especially long-lived shells.
3. **Container/remote tier auth** — how a remote sandbox mounts the workspace and
   where credentials come from without leaving `CMP-secrets`.
4. **Deny-glob materialization on Linux** — the fail-closed threshold (file count,
   scan depth) at which a glob makes the profile unstartable.
5. **macOS Seatbelt child-network** — the source renders a network rule, but child
   inheritance, IPC, and helper-process reach must be tested on macOS before deciding
   which guarantee level to advertise. A caller that requires a stronger level is
   refused. See `ARCH/23` ACC-P1-01 and TODO AX-114.
