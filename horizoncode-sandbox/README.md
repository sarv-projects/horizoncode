# horizoncode-sandbox

HorizonCode V1 OS-confinement backend for effectful worker processes
(architecture authority: `arch_V1/14-EFFECTS-EXECUTION-SECURITY.md` §14.5 and
§14.10; decision record: `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.4 DEC-V1-03).

The crate is a **fail-closed** process-confinement backend:

- `Sandbox::probe()` records what this host actually provides (bubblewrap
  presence/version, user/mount/pid/network/UTS namespace usability, Landlock
  ABI via a raw syscall probe). Discovery uses canonical system `bwrap` and
  `true` binaries with root ownership and no group/world writable ancestors;
  inherited `PATH` cannot select either probe executable.
- `Sandbox::prepare(&profile)` translates a `SandboxProfile` into a checked
  execution plan and returns a per-dimension guarantee vector with named
  residuals — or a typed `SandboxError::Unsupported`/`ProfileInvalid`. It never
  silently degrades to unconfined execution.
- `PreparedExecution::require(dimension, ExpectedLevel::ENFORCED)` is the
  caller-facing gate; a below-level result returns
  `SandboxError::GuaranteeNotMet` and the caller must not fall back.
- `PreparedExecution::spawn(&request)` starts the confined child with
  `bubblewrap` (or the explicitly requested weaker Landlock backend);
  `RunningChild::wait()` reaps it and removes any mount-target placeholders
  this crate created on the host.
- `PreparedExecution::prepare_external(&request)` prepares a bubblewrap argv
  for the existing kernel PTY supervisor. It refuses profiles requiring
  child-side descriptor hooks and all bare/Landlock plans. Keep the returned
  `ExternalLaunch` alive until the supervised process tree has been reaped;
  dropping it releases only the sandbox's synthetic mount targets.

## Profiles

| Profile | Meaning |
|---|---|
| `SandboxProfile::workspace_write(ws)` | Reads platform defaults + workspace, writes only inside `ws`, `.git`/`.agents`/`.codex`/`.horizoncode` protected read-only, no network, private `/tmp`. |
| `SandboxProfile::readonly(roots)` | Reads only the declared roots + platform defaults; no writes, no network. |
| `SandboxProfile::full_access()` | Explicit high-risk opt-in. Never described as confined; every dimension reports `unsupported`. |

`SandboxProfile::canonical_descriptor()` is deterministic and sorted; hash it
for `WorkerReuseKey.sandbox_profile` so a policy change cannot silently reuse a
worker confined by a different profile.

## Backends

- `ConfinementBackend::Bubblewrap` (default): fresh mount view,
  `--unshare-all` namespaces, scoped `--ro-bind`/`--bind` roots, protected
  subpaths re-applied read-only, deny masks (`--perms 000 --tmpfs` /
  `--ro-bind-data`), `--die-with-parent`, `--new-session`, `--cap-drop ALL`,
  private `/tmp`, WSL2 interop masking. Linux spawn also arms the direct child
  with `PR_SET_PDEATHSIG(SIGKILL)` and checks the parent PID after arming to
  close the fork/exec race. For the enforced bubblewrap process-tree profile,
  the parent-death signal terminates the namespace supervisor and
  `--die-with-parent` tears down its confined PID namespace.
- `ConfinementBackend::LandlockWriteScope` (explicitly requested only): raw
  Landlock syscalls for write scoping plus TCP denial on ABI ≥ 4. Reads,
  process tree and residual gaps are reported, not hidden. It is deliberately
  not layered under bubblewrap (rationale in `src/linux.rs`).
- Non-Linux platforms return typed `SandboxError::Unsupported`.

## Scope boundary

Deadlines, bounded/truncated output receipts, explicit cancellation, observed
exit, UNKNOWN reconciliation, effect leases and resource budgets belong to the
kernel `ExecutionHost` (`kernel/src/effect_host.rs`), not to this crate. The
Linux parent-death signal is only the crash fence; it is not a successful exit
receipt or proof that an operation completed.

## Tests

```sh
cargo test --offline          # capability-gated skips print typed reasons
HZ_SANDBOX_STRICT=1 cargo test --offline   # evidence run: skips become failures
```

`tests/confinement.rs` exercises real confinement (write scoping, network
denial, protected subpaths, deny masks, private tmp, environment clearing,
Landlock behavior). `tests/capability_matrix.rs` prints the per-kernel
capability/containment record (DEC-V1-03 evidence seed) and writes it to
`$CARGO_TARGET_TMPDIR/hz-sandbox-capability-record.txt`.

## Reference provenance

Design was informed by the read-only codex references
(`repos/codex/codex-rs/linux-sandbox/src/{bwrap.rs,landlock.rs}`,
`codex-rs/bwrap/src/main.rs`, Apache-2.0). Nothing was copied verbatim; only
mount-ordering, protected-subpath, namespace-probe and WSL-masking concepts
were adapted. §42 provenance is recorded by the parent.
