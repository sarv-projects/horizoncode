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

## Responsibilities

- Resolve a requested profile into a concrete confinement plan and apply it.
- Scope filesystem **read** and **write** access to the workspace under policy.
- Apply the **network policy**, defaulting to *no outbound network*.
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
| `CMP-tools` | inbound | `run(command, cwd, env, profile, limits) -> SandboxOutcome` for shell/exec; in-process fs ops consult `check_path` |
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
permissive dependencies used in-process.

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
ResolvedProfile = { backend, applied_at, mounts[], seccomp_mode, epoch }
SandboxOutcome  = { exit, stdout_ref, stderr_ref, denied?, violations[] }
```

- **Profiles:** `read-only` (write only to session state + temp; network off),
  `workspace-write` (default; write to workspace + session + temp; network off),
  `full-access` (no fs restriction, network allowed — still subject to Guard and the
  catastrophic gate, and still one egress path).
- **Protected subpaths:** VCS metadata/hooks and agent-owned configuration stay
  read-only inside any writable root so a write grant cannot rewrite the policy or
  install a hook that runs outside confinement.
- **Deny globs** are kernel-enforced read **and** write/rename, so a denied path
  cannot be read via a tool nor relocated out of the deny set and read elsewhere.
- A denied operation inside a namespace is reported as a **violation**, not a crash.

## Lifecycle & flows

### Once at startup
1. **Probe** each candidate backend for the platform and record availability.
2. Listen/apply the sandbox for the **whole process lifetime** for the agent's own
   file operations (in-process Landlock + `no_new_privs` + seccomp on Linux; a
   Seatbelt profile on macOS), so tool reads/writes are covered without per-call
   wrapping. On the Windows tier the AppContainer/restricted-token confinement is
   applied at spawn time.
3. Freeze the resolved profile: it is **immutable for the process lifetime**; a
   running session cannot relax it. Resuming a session re-applies the profile it was
   started with, and a request to *widen* a resumed session's profile is refused.
4. Child commands are spawned through the tier backend (e.g. a `bubblewrap`
   subprocess that constructs the filesystem view, then re-enters to apply seccomp
   and `exec`), all deriving from the same frozen profile.

### Per effect
1. `CMP-tools` receives a Guard `allow` and the resolved profile.
2. In-process fs operations call `check_path`; command execution calls `spawn`.
3. On Linux the local backend: creates user/mount/PID namespaces, mounts the scoped
   filesystem view, sets `--network=none` unless granted, drops capabilities
   (`capget` verified empty), sets `no_new_privs`, and installs the seccomp filter.
   The macOS and Windows tiers apply the equivalent mechanism their kernel provides
   (Seatbelt profile; AppContainer + restricted token/job objects) through the same
   interface, and report their documented limits.
4. Output is bounded and persisted by `CMP-runner`; the model sees a compact view.
5. Denials and violations append to `CMP-audit`; cancellation reaps the process tree.

### Network policy
- Default `none`: the child namespace has no usable network. On Linux a seccomp
  filter denies `connect`, `accept`, `bind`, `listen`, `sendto`, `sendmmsg`,
  `getsockopt`/`setsockopt`, and restricts `socket`/`socketpair` to `AF_UNIX`; it
  also denies `ptrace`, `process_vm_readv/writev`, `io_uring_*`, and VM sockets so a
  child cannot escape the filesystem view through host bridges.
- **Allowlist** grants specific `host:port` + protocol; the egress path is single and
  mediated, so an allowed host still cannot be reached by a disallowed protocol.
- **Process/child-network blocking** is the same filter applied to every descendant;
  there is no "trusted child" exemption.

## Profile matrix

| Profile | FS read | FS write | Network | Use |
|---|---|---|---|---|
| `read-only` | scoped read | session state + temp only | off | Exploration, review, untrusted analysis |
| `workspace-write` (default) | scoped read | workspace + session + temp | off | Everyday repo work |
| `full-access` | unrestricted | unrestricted | allowed | Explicit, audited user activation only |

`full-access` widens capability but never bypasses Guard: the catastrophic gate and
the single-egress rule still apply.

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
  read/write denial and syscall/egress denial are both available.
- **macOS (first enforcement target).** A Seatbelt-profile backend implements the
  same `SandboxProvider` trait and is an acceptance target for real containment.
  Path containment is kernel-enforced by the Seatbelt profile; **child-process
  network denial is best-effort at this tier** and must be documented as such
  whenever a network-restricted profile is requested.
- **Windows (fully supported target; distinct tier).** Confinement uses an
  **AppContainer** boundary plus a **restricted token** and **job objects** for
  process/child containment. Job objects alone govern process lifetime, job-wide
  limits, and child membership — they do **not** by themselves deny filesystem paths
  or outbound network the way Landlock + seccomp do; AppContainer capability plus
  file/registry ACLs carry the path and network part. This tier therefore has its own
  acceptance tests (`TODO.md` Windows-containment task) and its limits are stated
  honestly rather than described as equivalent. Availability is probed; a requested
  backend that cannot be established fails closed. WSL is an execution backend, not
  the Windows storage root.

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
    "workspace": { "writable": ["**"], "protected": [".git/hooks", ".agentx"] },
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

- **Containment tests:** a command cannot read a denied path, cannot write outside
  the writable roots, and cannot rename a denied path out of the deny set.
- **Network tests:** with `network: none`, `connect`-class syscalls fail and only
  `AF_UNIX` sockets succeed; with an allowlist, only granted `host:port`+protocol
  succeed.
- **Capability test:** after setup, effective/permitted capabilities are empty.
- **Fail-closed tests:** with the backend removed, the effect is denied and audited,
  not run unconfined.
- **Escape tests:** nested namespace rearrangement, VM-socket bridges, and
  synthetic-mount cleanup are exercised; a violation forces a non-zero outcome.
- **Parity:** the same test suite runs against each tier that advertises support.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-GUARD-004` | Sandboxed execution defaults to workspace-scoped writes and network off. |
| `REQ-TOOL-003` | Denied tools are absent via Guard; the sandbox independently confines the rest. |
| `REQ-SEC-003` | Filesystem and network targets validated against the resolved profile before use. |
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
5. **macOS Seatbelt child-network** — whether best-effort blocking is acceptable or
   the backend must be marked unsupported for network-restricted profiles, and how
   that limit is surfaced in the acceptance record (`TODO.md` macOS task).
