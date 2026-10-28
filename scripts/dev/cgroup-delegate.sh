#!/usr/bin/env bash
# Delegate one cgroup-v2 subtree to the invoking user so unprivileged runs can
# bind per-effect containment. Guarded terminal execution creates a cgroup per
# effect below the caller's own delegated cgroup (see kernel/src/cgroup_v2.rs),
# which is the normal layout under a systemd user slice. WSL and bare container
# CI have no user slice, so this script performs the one-time root step:
#
#   sudo bash scripts/dev/cgroup-delegate.sh
#
# It is idempotent and changes nothing outside the named subtree. Use it with
# scripts/dev/with-cgroup.sh, which moves a command into the delegated group.
set -euo pipefail

TARGET_USER="${TARGET_USER:-${SUDO_USER:-$(id -un)}}"
CGROUP_NAME="${HZ_TEST_CGROUP_NAME:-horizoncode-tests}"
PARENT="${HZ_CGROUP_PARENT:-/sys/fs/cgroup}"
SUBTREE="$PARENT/$CGROUP_NAME"

fail() {
  printf 'cgroup-delegate: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "must run as root (try: sudo bash $0)"
[ -d "$PARENT" ] || fail "no cgroup-v2 mount at $PARENT"
id "$TARGET_USER" >/dev/null 2>&1 || fail "unknown target user: $TARGET_USER"
UID_OF="$(id -u "$TARGET_USER")"
GID_OF="$(id -g "$TARGET_USER")"

mkdir -p "$SUBTREE"
# Delegation in cgroup v2 is ownership of the directory plus its control files.
# No controller is enabled: guarded terminal containment needs the tree, not CPU
# or memory accounting (the optional CodeMode profile enables those itself).
chown "$UID_OF:$GID_OF" "$SUBTREE"
for control in cgroup.procs cgroup.threads cgroup.events cgroup.kill cgroup.subtree_control cgroup.freeze; do
  if [ -e "$SUBTREE/$control" ]; then
    chown "$UID_OF:$GID_OF" "$SUBTREE/$control"
  fi
done

# Prove the delegation is usable by the target user before reporting success.
if ! sudo -u "$TARGET_USER" test -w "$SUBTREE/cgroup.procs"; then
  fail "delegated cgroup.procs is not writable by $TARGET_USER"
fi

printf 'cgroup-delegate: %s owned by %s (uid %s)\n' "$SUBTREE" "$TARGET_USER" "$UID_OF"
