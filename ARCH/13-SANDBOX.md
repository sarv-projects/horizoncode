# 13 — Sandbox (`CMP-sandbox`)

## Purpose

`CMP-sandbox` is the **enforcement layer** for platform confinement and egress. Where
`CMP-guard` decides *whether* an action may run, `CMP-sandbox` guarantees *what the
resulting process can actually reach* — filesystem, network, and child processes —
using OS-level primitives. Every tier presents **one `SandboxProvider` interface** so
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
- Block child-process network and dangerous syscalls (process inspection, VM
  sockets, `io_uring`) unless explicitly granted.
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
| Local (default) | Linux: namespaces via `bubblewrap` **as a subprocess**, Landlock, seccomp · macOS: Seatbelt profile · Windows: AppContainer + restricted token/job objects | `--network=none` default; workspace-write only |
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
  deny:            [Glob],             // kernel-enforced read+write denial
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
- **Deny globs** are kernel-enforced read **and** write/rename, so a denied path
  cannot be read via a tool nor relocated out of the deny set and read elsewhere.
- **Reads are scoped to the granted roots on every tier** (`REQ-SEC-025`). This is a
  reach property enforced here, not an authorization the caller performed: Linux
  materializes a mount view containing only the granted roots; the macOS Seatbelt
  profile's `file-read*` grants MUST be expressed as granted-root subpath allows
  rather than a blanket read; Windows relies on the AppContainer file ACLs. A spawn
  naming an absolute path outside the granted roots is **rejected**, or masked so the
  target does not exist in the child's view.
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
4. Child commands are spawned through the tier backend (e.g. a `bubblewrap`
   subprocess that constructs the filesystem view, then re-enters to apply seccomp
   and `exec`), all deriving from the same frozen profile.

### Per effect
1. `CMP-tools` receives a Guard `allow` and the resolved profile.
2. In-process fs operations call `check_path` and use a handle-relative/no-follow
   open or rename where available; `check_path` alone is not a kernel boundary or
   a complete TOCTOU defense. Command execution calls `spawn` with a frozen child
   profile. A platform lacking the required safe path primitive refuses the effect.
3. On Linux the local backend: creates user/mount/PID namespaces, mounts the scoped
   filesystem view, sets `--network=none` unless granted, drops capabilities
   (`capget` verified empty), sets `no_new_privs`, and installs the seccomp filter.
   The macOS and Windows tiers apply the equivalent mechanism their kernel provides
   (Seatbelt profile; AppContainer + restricted token/job objects) through the same
   interface, and report their documented limits.
4. Output is bounded and persisted by `CMP-runner`; the model sees a compact view.
5. Denials and violations append to `CMP-audit`; cancellation reaps the process tree.

### Network policy
- Default `none`: the child namespace has no usable network **to the extent the tier
  can prove**. The mechanism differs per tier, so the level it reaches is declared,
  never assumed (§Platform notes, `DEC-026`).
- On Linux, where the level is `enforced`, a seccomp filter denies `connect`,
  `accept`, `bind`, `listen`, `sendto`, `sendmmsg`, `getsockopt`/`setsockopt`, and
  restricts `socket`/`socketpair` to `AF_UNIX`; it also denies `ptrace`,
  `process_vm_readv/writev`, `io_uring_*`, and VM sockets so a child cannot escape the
  filesystem view through host bridges.
- On Windows the level is `capability`: egress is denied by **absence of the network
  capability** inside the AppContainer, not by a syscall filter — job objects do not
  deny network. On macOS the level is `best_effort`: the Seatbelt rule binds the
  wrapped process, and an escaped descendant is **not** separately confined. In both
  cases the residual is recorded on the resolved profile and disclosed; neither tier
  claims `enforced`.
- **Allowlist** grants specific `host:port` + protocol through the mediated agent
  egress. A child with network access must be forced through an unbypassable broker;
  a broad child network namespace plus an application HTTP check is insufficient.
  If forced mediation is unavailable, that child profile is refused.
- **Process/child-network blocking** is the same filter applied to every descendant;
  there is no "trusted child" exemption.
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
product importance. Linux and macOS are the **first enforcement targets**: each has
a kernel mechanism that denies filesystem paths and restricts syscalls at the kernel
boundary, so real containment is a first-class acceptance target there. Windows is a
**fully supported target** with its own containment tier, its own acceptance tests,
and limits stated honestly — it is not dropped, and it is not claimed to be
equivalent to the Unix path/syscall denial described above.

- **Linux (local default, first enforcement target).** `bubblewrap` + Landlock +
  seccomp stacked; Landlock is the fallback when bubblewrap is unavailable for a
  profile that does not require read-deny. Read-deny requires bubblewrap; if it is
  missing, refuse rather than run with denied paths exposed. Kernel-enforced path
  read/write denial and syscall/egress denial are both available. Read scoping comes
  from the mount view: only the granted roots are visible to the child.
- **macOS (first enforcement target).** A Seatbelt-profile backend implements the
  same `SandboxProvider` trait and is an acceptance target for real containment.
  Path containment is kernel-enforced by the Seatbelt profile, and `file-read*` grants
  MUST be issued as granted-root subpath allows rather than a blanket read, so reads
  are scoped to the granted roots like every other tier. **Child-process network
  denial is `best_effort` at this tier** — the rule binds the wrapped process, and an
  escaped descendant is not separately confined — which must be declared and
  displayed wherever a network-restricted profile is presented (`DEC-026`).
- **Windows (fully supported target; distinct tier).** Confinement uses an
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

Every tier **declares** the level it provides. `enforced` is a kernel/syscall or
OS-capability denial of egress; `best_effort` limits denial to the wrapped process;
`none` means no network guarantee. A tier MUST NOT claim a level stronger than it can
prove, and a caller that requires a level the tier does not provide MUST be refused.
`DEC-027` is the formal read-through that makes "network off" a *request* everywhere in
the document set and never a claim about what a tier enforces.

| Tier | Level | Mechanism | Residual |
|---|---|---|---|
| Linux (local) | `enforced` | seccomp egress filter + network namespace | A denial proves the syscall/network bar for this tier; loopback is corroboration only, never the proof. |
| macOS (local) | `best_effort` | Seatbelt rule on the wrapped process | An escaped descendant is not separately confined; allowlist entries are already reported `Unsupported` for this reason. |
| Windows (local) | `capability` | AppContainer **capability absence** (deny-by-absence, not a syscall filter) | Job objects do not deny network; an in-container process holding the capability would not be filtered. |
| Container / remote | declared by the tier | the tier's own isolation boundary | Whatever the tier declares is recorded verbatim; the interface is not upgraded by assumption. |

`enforced` is the level a caller must demand for a hard "no egress" claim. The
`best_effort` and `capability` levels are supported, disclosed postures — not
"unsupported" tiers — and the difference is enforced by refusing an unmeetable
requirement rather than by downgrading it silently.

## Failure modes

| Failure | Behavior |
|---|---|
| Backend unavailable | Try the next backend; if none, **deny with reason** — never unconfined by default |
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
- **Network tests, per declared level** (`DEC-026`, `ACC-P1-01(d)`): at `enforced`,
  the `connect`-class syscalls fail and only `AF_UNIX` sockets succeed; at `capability`,
  the outbound attempt fails because the capability is absent; at `best_effort`, the
  wrapped process is denied and the residual (an escaped descendant is not separately
  confined) is proven to be **disclosed** in the surface and the record. With an
  allowlist, only granted `host:port`+protocol succeed.
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
| `REQ-SEC-003` | This module is the sole path *reach* enforcer: `check_path` and `spawn` enforce the resolved profile's scoped roots and kernel-enforced deny globs over the whole process tree, so validation happens at the enforcement boundary, not in a pre-scan. |
| `REQ-SEC-025` | Sole path reach owner: reads are scoped to the granted roots on every tier, a spawn naming an absolute path outside them is rejected or masked, deny-glob/protected-subpath matches are denied at the kernel, and a tier that cannot confine the reach refuses the effect (`DEC-024`, `DEC-025`). |
| `REQ-LOOP-005` | Cancellation propagates to process trees; partial state stays inspectable. |
| `REQ-ORCH-003` | Per-subagent writable scopes are non-overlapping worktrees or explicitly merged. |
| `REQ-PERF-001` | Startup probe is bounded; the warm-cache prompt target is unaffected. |

## Open questions

1. **Windows acceptance matrix** — the distinct Windows tier is decided
   (AppContainer + restricted token/job objects; see Platform notes); the open item
   is the exact per-restriction test matrix: which filesystem, registry, child-process,
   and network restrictions are proven by which mechanism, and the acceptance test
   that records each (`TODO.md` Windows-containment task).
2. **Once-at-startup vs. per-command wrapping** — confirm the split between the
   process-lifetime in-process confinement and the per-command subprocess view for
   every tool, especially long-lived shells.
3. **Container/remote tier auth** — how a remote sandbox mounts the workspace and
   where credentials come from without leaving `CMP-secrets`.
4. **Deny-glob materialization on Linux** — the fail-closed threshold (file count,
   scan depth) at which a glob makes the profile unstartable.
5. **macOS Seatbelt child-network** — **Resolved by `DEC-026`, read through by
   `DEC-027`:** best-effort
   blocking is **allowed**, but the tier must declare `best_effort` with its residual,
   surface the level wherever a network-restricted profile is presented, record it in
   the acceptance record, and **refuse** a caller that requires `enforced`. macOS is
   not declared unsupported for network-restricted profiles; the level is the
   disclosure (`RR-07`, `ARCH/23` Open question 8). What remains open is the exact
   per-restriction test matrix for the tier (`TODO.md` `AX-114`).
