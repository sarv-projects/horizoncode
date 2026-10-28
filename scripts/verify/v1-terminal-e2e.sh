#!/usr/bin/env bash
# Guarded terminal journeys against the real Rust supervisor.
#
# These three journeys drive a model tool call through the approval dialog, the
# one-use capability lease and the contained process tree, so they need a
# delegated cgroup-v2 subtree (see scripts/dev/cgroup-delegate.sh). A systemd
# host already provides one through the user slice; WSL and bare container CI
# need the one-time root delegation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.bun/bin:$PATH"

CGROUP_NAME="${HZ_TEST_CGROUP_NAME:-horizoncode-tests}"
SUBTREE="${HZ_TEST_CGROUP:-/sys/fs/cgroup/$CGROUP_NAME}"

fail() {
  printf 'V1-TERMINAL-E2E=FAIL %s\n' "$*" >&2
  exit 1
}

[ -d "$SUBTREE" ] || fail "no delegated cgroup at $SUBTREE (run: sudo bash scripts/dev/cgroup-delegate.sh)"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"
[ -x kernel/target/debug/session_supervisor ] || fail "kernel/target/debug/session_supervisor is missing (cargo build --bin session_supervisor --bin hz-kernel)"

RUN="${1:-$(date +%Y%m%d-%H%M%S)}"
LOGDIR=".tmp/terminal-e2e/$RUN"
mkdir -p "$LOGDIR"
pass=0
failures=0

run_journey() {
  local label="$1" pattern="$2"
  local log="$LOGDIR/$label.log"
  local rc=0
  printf 'V1-TERMINAL-E2E %-28s ' "$label"
  bash scripts/dev/with-cgroup.sh env -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
    timeout 300 bash -c "cd '$ROOT/packages/opencode' && bun test --timeout 180000 test/session/prompt.test.ts -t '$pattern'" \
    >"$log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && grep -Eq '^\(pass\)' "$log" && ! grep -q '^\(fail\)' "$log"; then
    pass=$((pass + 1))
    printf 'PASS  %s\n' "${log#"$ROOT"/}"
    return 0
  fi
  failures=$((failures + 1))
  printf 'FAIL (exit %s)  %s\n' "$rc" "${log#"$ROOT"/}" >&2
  grep -E '^\(fail\)|error:' "$log" | head -5 >&2 || true
  return 1
}

run_journey bash-approval "V1 model bash waits for Rust approval" || true
run_journey slash-command-approval "single slash-command shell interpolation executes after Rust approval" || true
run_journey slash-command-denied "single slash-command shell interpolation waits for Rust approval and does not spawn when denied" || true

printf 'V1-TERMINAL-E2E journeys=%s pass=%s fail=%s logs=%s\n' 3 "$pass" "$failures" "${LOGDIR#"$ROOT"/}"
[ "$failures" -eq 0 ] || exit 1
printf 'V1-TERMINAL-E2E=PASS\n'
