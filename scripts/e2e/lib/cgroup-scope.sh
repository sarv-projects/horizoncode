#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Terminal effects require a cgroup-v2 subtree OWNED BY THE EXECUTION PRINCIPAL.
# kernel/src/cgroup_v2.rs::ExecutionCgroupV2::create fails closed with
#   "delegated cgroup root is not owned by the ExecutionHost principal"
# whenever the current cgroup directory is root-owned -- which is exactly where
# a process lands when it is started from a plain `wsl.exe ... bash -lc` shell
# (cgroup "/non-systemd", drwxr-xr-x root root). The failure is reported as
# `effect_outcome_unknown` / `effect_denied`, so bash silently never runs.
#
# Starting the same command inside a delegated systemd user scope puts it in
# /user.slice/user-1000.slice/user@1000.service/app.slice/run-*.scope, which
# systemd chowns to the invoking user, so containment binds.
#
# hz_scope_prefix prints the argv prefix to prepend to a long-lived server
# command (empty when the current cgroup is already user-owned). It never
# silently degrades: HZ_REQUIRE_SCOPE=1 makes a missing systemd user manager a
# hard error.
# ---------------------------------------------------------------------------

hz_cgroup_path() { sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null | head -n1; }

hz_cgroup_owned() {
  local path owner
  path="$(hz_cgroup_path)"
  [ -n "$path" ] || return 1
  owner="$(stat -c '%u' "/sys/fs/cgroup$path" 2>/dev/null || echo x)"
  [ "$owner" = "$(id -u)" ]
}

hz_scope_available() {
  systemctl --user is-system-running >/dev/null 2>&1 || systemctl --user status >/dev/null 2>&1
}

# Prints a shell-quoted prefix; call as: eval "prefix=\$(hz_scope_prefix)".
hz_scope_prefix() {
  if hz_cgroup_owned; then
    printf ''
    return 0
  fi
  if hz_scope_available; then
    printf 'systemd-run --user --scope -p Delegate=yes --'
    return 0
  fi
  if [ "${HZ_REQUIRE_SCOPE:-0}" = "1" ]; then
    printf 'HZ_SCOPE_UNAVAILABLE'
    return 1
  fi
  printf ''
}

# Runs exactly one command with the scope prefix applied, in the foreground.
hz_scope_exec() {
  if hz_cgroup_owned; then
    exec "$@"
  fi
  if hz_scope_available; then
    exec systemd-run --user --scope -p Delegate=yes -- "$@"
  fi
  if [ "${HZ_REQUIRE_SCOPE:-0}" = "1" ]; then
    echo "cgroup scope unavailable: terminal containment cannot bind (cgroup $(hz_cgroup_path))" >&2
    exit 97
  fi
  echo "cgroup scope unavailable: running outside a delegated scope; terminal effects will fail closed" >&2
  exec "$@"
}

# Re-executes the CURRENT script inside a delegated scope when it did not start
# in one. Terminal containment in kernel/src/cgroup_v2.rs needs a cgroup owned by
# the ExecutionHost principal, so a harness launched from `wsl.exe ... bash -lc`
# (cgroup /non-systemd, root-owned) can never run bash. Keeps argv and exit code.
hz_ensure_scope() {
  [ "${HZ_IN_SCOPE:-0}" = "1" ] && return 0
  hz_cgroup_owned && return 0
  if ! hz_scope_available; then
    if [ "${HZ_REQUIRE_SCOPE:-0}" = "1" ]; then
      echo "HZ_SCOPE_UNAVAILABLE cgroup=$(hz_cgroup_path) owner=$(stat -c '%u' "/sys/fs/cgroup$(hz_cgroup_path)" 2>/dev/null)" >&2
      exit 97
    fi
    echo "WARN cgroup $(hz_cgroup_path) is not user-owned and systemd --user is unavailable; terminal effects will fail closed" >&2
    return 0
  fi
  export HZ_IN_SCOPE=1
  echo "SCOPE re-exec under delegated systemd user scope (was cgroup $(hz_cgroup_path))" >&2
  exec systemd-run --user --scope -p Delegate=yes -- "$0" "$@"
}
