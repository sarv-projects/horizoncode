#!/usr/bin/env bash
# Run a command inside the cgroup-v2 subtree delegated by cgroup-delegate.sh.
#
#   bash scripts/dev/with-cgroup.sh cargo test --test tool_batch_guard_matrix
#   bash scripts/dev/with-cgroup.sh bun test test/session/prompt.test.ts
#
# Guarded terminal execution binds a per-effect cgroup below the caller's own
# cgroup, so the caller must already be inside a writable delegated subtree.
# Children inherit the cgroup, which is why the wrapper moves itself and execs
# rather than parenting the command.
#
# A systemd host already places the session in a user-owned slice, so step 1
# succeeds and nothing privileged happens. WSL and bare container CI start in a
# root-owned cgroup, and cgroup-v2 forbids a user from migrating itself out of a
# subtree it does not own: step 2 performs that one migration through
# passwordless sudo, after which the subtree is fully delegated to this user.
set -euo pipefail

CGROUP_NAME="${HZ_TEST_CGROUP_NAME:-horizoncode-tests}"
SUBTREE="${HZ_TEST_CGROUP:-/sys/fs/cgroup/$CGROUP_NAME}"

fail() {
  printf 'with-cgroup: %s\n' "$*" >&2
  exit 1
}

[ "$#" -gt 0 ] || fail "usage: with-cgroup.sh <command> [args...]"
[ -d "$SUBTREE" ] || fail "no delegated cgroup at $SUBTREE (run: sudo bash scripts/dev/cgroup-delegate.sh)"

current="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
if [ "$current" != "/$CGROUP_NAME" ]; then
  if [ -w "$SUBTREE/cgroup.procs" ] && printf '%s\n' "$$" > "$SUBTREE/cgroup.procs" 2>/dev/null; then
    :
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    # The shell's own pid is what must move: sudo runs a child, so pass the pid.
    sudo -n sh -c "printf '%s\n' '$$' > '$SUBTREE/cgroup.procs'" \
      || fail "could not move pid $$ into $SUBTREE"
  else
    fail "cannot enter $SUBTREE: run 'sudo bash scripts/dev/cgroup-delegate.sh' once"
  fi
fi

moved="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
[ "$moved" = "/$CGROUP_NAME" ] || fail "still in cgroup $moved after migration"
exec "$@"
