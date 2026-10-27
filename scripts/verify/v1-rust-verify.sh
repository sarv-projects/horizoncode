#!/usr/bin/env bash
# scripts/verify/v1-rust-verify.sh
#
# HorizonCode V1 final acceptance -- RUST / Kernel companion verifier (AGENTS.md §9).
#
# This script covers the RUST/Kernel side of V1 final verification. The
# TypeScript / overlay / P8-Python side lives in the sibling verifier
# scripts/verify/v1-final-verify.sh, which has NO Cargo steps. Run THIS script
# AFTER v1-final-verify.sh passes. Together the two scripts make up the full §9
# batch (TS side + Rust side).
#
# SERIAL-SAFE / LOCKS (critical):
#   Only ONE Cargo may run at a time in this repo. Three Cargo target dirs can
#   each hold a `.cargo-lock`; this verifier refuses to start (exit 2) unless
#   ALL THREE are free, checked with `fuser -v`:
#     target-p2/debug/.cargo-lock
#     kernel/target/debug/.cargo-lock
#     indexd/target/debug/.cargo-lock
#   `fuser -v <lock>` exits 1 (FREE = ok) or 0 (BUSY = another Cargo is running
#   -> we refuse to start). v1-final-verify.sh runs NO Cargo, so running this
#   after it is serial-safe. Do NOT run this concurrently with any other Cargo.
#
# SPEED EXPECTATION:
#   Cargo builds are the SLOW step of the §9 batch. A cold build can take tens
#   of minutes; warm incremental runs are faster but still minutes. Every test
#   runs with `--test-threads=1` for deterministic, serialized test execution
#   (determinism over speed). Budget generously; do not interrupt a build.
#
# Environment (self-set INSIDE this script -- do NOT rely on the caller's $VAR;
# a known quirk is that inline $VAR in `wsl.exe bash -lc` gets pre-expanded to
# empty by an intermediate shell, so this script sets its own vars internally
# and is invoked BY PATH with no `$` in the outer string):
#   CARGO_BUILD_JOBS=1              one build job (lock-friendly, deterministic)
#   CARGO_TARGET_DIR=../target-p2   relative to kernel/ -> <repo>/target-p2
#   TMPDIR / TMP / TEMP             pinned repo-local under .tmp/final-verify/<stamp>
#   Every cargo step uses `--locked --offline`: no network, locked deps.
#
# Provider API keys are unset for every step (`env -u ...`): no paid route, no
# network fetch is required by any step.
#
# Usage:
#   # from inside WSL, AFTER v1-final-verify.sh passes:
#   bash scripts/verify/v1-rust-verify.sh
#   # SAFE caller from Windows (NO `$` in the outer string; script sets its own vars):
#   wsl.exe -d Ubuntu-24.04 -- bash /home/sarvesh/business_Dev/agentx/scripts/verify/v1-rust-verify.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_ROOT="$ROOT/.tmp/final-verify/$STAMP"
LOG_DIR="$LOG_ROOT/rust-logs"
TMP_INREPO="$LOG_ROOT/tmp"
SUMMARY_FILE="$LOG_ROOT/summary-rust.txt"

# Cargo target dir RELATIVE to kernel/ (every cargo step runs with cwd=kernel/).
CARGO_TARGET_DIR_REL="../target-p2"
CARGO_BUILD_JOBS_VAL=1

# The three Cargo locks that must be FREE before any Cargo may start.
LOCK_TARGET_P2="$ROOT/target-p2/debug/.cargo-lock"
LOCK_KERNEL="$ROOT/kernel/target/debug/.cargo-lock"
LOCK_INDEXD="$ROOT/indexd/target/debug/.cargo-lock"

# Minimum free disk (KB) required to start a Cargo build: 5 GiB.
MIN_FREE_KB=5242880

# Provider credentials must never be exercised by final verification.
ENV_SCRUB=(env
  -u OPENCODE_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY
  -u OPENCODE_GO_API_KEY -u GOOGLE_GENERATIVE_AI_API_KEY
  -u OPENROUTER_API_KEY -u DEEPSEEK_API_KEY -u XAI_API_KEY
  -u GROQ_API_KEY -u COHERE_API_KEY -u MISTRAL_API_KEY)

# ---------------------------------------------------------------- preflight
fail_preflight() {
  printf 'V1-RUST-VERIFY PREFLIGHT FAIL: %s\n' "$*" >&2
  exit 2
}

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) : ;;
  *) fail_preflight "must run inside WSL/Linux (repo Cargo targets are Linux); use: wsl.exe -d Ubuntu-24.04 -- bash scripts/verify/v1-rust-verify.sh" ;;
esac
if ! command -v cargo >/dev/null 2>&1 && [ -x "${HOME:-/root}/.cargo/bin/cargo" ]; then
  export PATH="${HOME:-/root}/.cargo/bin:$PATH"
fi
command -v cargo >/dev/null 2>&1 || fail_preflight "cargo not found on PATH"
command -v fuser >/dev/null 2>&1 || fail_preflight "fuser not found on PATH (needed to assert Cargo locks are free)"
[ -d "$ROOT/kernel" ] || fail_preflight "kernel/ not found under $ROOT"

# All three Cargo locks must be FREE: only ONE Cargo may run at a time.
# fuser exits 0 when some process holds the file (BUSY), 1 when FREE. A missing
# lock file cannot be held, so it counts as FREE.
assert_lock_free() {
  local lock="$1"
  [ -e "$lock" ] || return 0
  if fuser -v "$lock" >/dev/null 2>&1; then
    fail_preflight "Cargo lock is BUSY (another Cargo is running) -- refusing to start: $lock"
  fi
  return 0
}
assert_lock_free "$LOCK_TARGET_P2"
assert_lock_free "$LOCK_KERNEL"
assert_lock_free "$LOCK_INDEXD"

# Enough free disk to build.
avail_kb="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
case "$avail_kb" in
  ''|*[!0-9]*) fail_preflight "could not determine free disk under $ROOT" ;;
esac
if [ "$avail_kb" -lt "$MIN_FREE_KB" ]; then
  fail_preflight "insufficient free disk under $ROOT: ${avail_kb} KB available, need >= ${MIN_FREE_KB} KB (5 GiB) for the Cargo build"
fi

mkdir -p "$LOG_DIR" "$TMP_INREPO" || fail_preflight "cannot create repo-local log/tmp dirs under $LOG_ROOT"

# Self-set env for every step (never rely on the caller's $VAR).
export TMPDIR="$TMP_INREPO"          # repo-local; never system temp
export TMP="$TMP_INREPO"
export TEMP="$TMP_INREPO"
export CARGO_BUILD_JOBS="$CARGO_BUILD_JOBS_VAL"
export CARGO_TARGET_DIR="$CARGO_TARGET_DIR_REL"

# ------------------------------------------------------------- bookkeeping
# Full expected plan, in order. Anything declared here but not executed when
# the run stops is reported as SKIPPED in the summary.
EXPECTED_STEPS=(
  01-rust-host-run
  01a-host-run-nonempty
  01b-host-run-ok
  01c-host-run-no-failed
  02-rust-managed-control
  02a-managed-control-nonempty
  02b-managed-control-ok
  02c-managed-control-no-failed
  03-rust-codemode-inspect
  03a-codemode-inspect-nonempty
  03b-codemode-inspect-ok
  03c-codemode-inspect-no-failed
  04-rust-tool-batch-guard
  04a-tool-batch-guard-nonempty
  04b-tool-batch-guard-ok
  04c-tool-batch-guard-no-failed
  05-rust-effect-host
  05a-effect-host-nonempty
  05b-effect-host-ok
  05c-effect-host-no-failed
  06-rust-secret-use-lib
  06a-secret-use-lib-nonempty
  06b-secret-use-lib-ok
  06c-secret-use-lib-no-failed
  07-rust-secret-use-grant
  07a-secret-use-grant-nonempty
  07b-secret-use-grant-ok
  07c-secret-use-grant-no-failed
)

declare -A STEP_EXIT=()
declare -A STEP_LOG=()
declare -A STEP_STATE=()

STEP_INDEX=0
FAILED_STEP=""

now() { date +%Y-%m-%dT%H:%M:%S%z; }

print_summary() {
  local id state
  {
    printf '==================== v1-rust-verify summary (%s) ====================\n' "$STAMP"
    printf '%-32s %-8s %s\n' "STEP" "RESULT" "LOG"
    for id in "${EXPECTED_STEPS[@]}"; do
      state="${STEP_STATE[$id]:-SKIPPED}"
      printf '%-32s %-8s %s\n' "$id" "$state" "${STEP_LOG[$id]:--}"
    done
    if [ -n "$FAILED_STEP" ]; then
      printf 'RESULT: FAIL -- stopped at first failure: %s (exit %s)\n' \
        "$FAILED_STEP" "${STEP_EXIT[$FAILED_STEP]:-?}"
    else
      printf 'RESULT: PASS -- all %s planned steps executed green\n' "${#EXPECTED_STEPS[@]}"
    fi
    printf 'logs: %s\n' "${LOG_ROOT#"$ROOT"/}"
  } | tee "$SUMMARY_FILE"
}

# run_step <label> <workdir> <cmd...>
# stdout+stderr -> timestamped repo-local rust-logs/ file; exit code recorded;
# PASS/FAIL printed; on failure the log tail is echoed and the run STOPS
# (fail-closed, first failure).
run_step() {
  local label="$1" wd="$2"; shift 2
  STEP_INDEX=$((STEP_INDEX + 1))
  local log="$LOG_DIR/${STAMP}-$(printf '%02d' "$STEP_INDEX")-${label}.log"
  local rc=0
  printf '[%s] STEP %s  (cd %s && %s)\n' "$(now)" "$label" "$wd" "$*"
  (
    cd "$wd" || exit 1
    "${ENV_SCRUB[@]}" \
      TMPDIR="$TMP_INREPO" TMP="$TMP_INREPO" TEMP="$TMP_INREPO" \
      CARGO_BUILD_JOBS="$CARGO_BUILD_JOBS_VAL" \
      CARGO_TARGET_DIR="$CARGO_TARGET_DIR_REL" \
      "$@"
  ) >"$log" 2>&1 || rc=$?
  STEP_EXIT["$label"]=$rc
  STEP_LOG["$label"]="$log"
  if [ "$rc" -eq 0 ]; then
    STEP_STATE["$label"]=PASS
    printf '[%s] STEP %s: PASS (exit 0)  log=%s\n' "$(now)" "$label" "${log#"$ROOT"/}"
    return 0
  fi
  STEP_STATE["$label"]=FAIL
  FAILED_STEP="$label"
  printf '[%s] STEP %s: FAIL (exit %s)  log=%s\n' "$(now)" "$label" "$rc" "${log#"$ROOT"/}" >&2
  printf -- '--- %s: last 40 log lines ---\n' "$label" >&2
  tail -n 40 "$log" >&2 2>/dev/null
  printf -- '--- end %s log tail ---\n' "$label" >&2
  print_summary
  printf 'V1-RUST-VERIFY=FAIL first_failure=%s exit=%s logs=%s\n' "$label" "$rc" "${LOG_ROOT#"$ROOT"/}" >&2
  exit 1
}

# check_step <label> <must|mustnot> <extended-regex> <file>
# Fail-closed assertion against an already-captured step log; recorded in the
# summary table exactly like a run_step.
check_step() {
  local label="$1" mode="$2" pattern="$3" file="$4"
  STEP_INDEX=$((STEP_INDEX + 1))
  local rc=1
  if [ -f "$file" ]; then
    if grep -Eq -- "$pattern" "$file"; then
      # A match fails `mustnot` and satisfies `must`.
      [ "$mode" = mustnot ] && rc=1 || rc=0
    else
      grep_rc=$?
      # grep status 1 means no match; status 2+ is an assertion error, not
      # evidence that the forbidden pattern was absent.
      if [ "$mode" = mustnot ] && [ "$grep_rc" -eq 1 ]; then
        rc=0
      else
        rc=1
      fi
    fi
  fi
  STEP_EXIT["$label"]=$rc
  STEP_LOG["$label"]="$file"
  if [ "$rc" -eq 0 ]; then
    STEP_STATE["$label"]=PASS
    printf '[%s] CHECK %s: PASS (%s /%s/ %s)\n' "$(now)" "$label" "$mode" "$pattern" "${file#"$ROOT"/}"
    return 0
  fi
  STEP_STATE["$label"]=FAIL
  FAILED_STEP="$label"
  printf '[%s] CHECK %s: FAIL (%s /%s/ %s)\n' "$(now)" "$label" "$mode" "$pattern" "${file#"$ROOT"/}" >&2
  print_summary
  printf 'V1-RUST-VERIFY=FAIL first_failure=%s exit=1 logs=%s\n' "$label" "${LOG_ROOT#"$ROOT"/}" >&2
  exit 1
}

# ------------------------------------------------------------------- steps
printf 'v1-rust-verify: run=%s root=%s cargo_target_dir=%s(cwd=kernel/) build_jobs=%s\n' \
  "$STAMP" "$ROOT" "$CARGO_TARGET_DIR_REL" "$CARGO_BUILD_JOBS_VAL"
printf 'provider API keys are unset; all scratch state is under .tmp/final-verify/; every step is --locked --offline\n'
printf 'NOTE: Cargo builds are the slow §9 step; each test runs --test-threads=1 for determinism.\n'

# Library filters use `--lib`; the Guard matrix is the integration target
# from kernel/, one at a time, serial. Exit 0 alone is not trusted: the captured
# log must contain `test result: ok` (must) and must NOT contain
# `test result: FAILED` (mustnot) -- mirrors the P8 "Ran 28" + "OK" rigor.

# 1. host_run -- Rust host-side run principal / orchestration tests.
run_step 01-rust-host-run "$ROOT/kernel" \
  cargo test --locked --offline --lib host_run -- --test-threads=1
check_step 01a-host-run-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[01-rust-host-run]}"
check_step 01b-host-run-ok must 'test result: ok' \
  "${STEP_LOG[01-rust-host-run]}"
check_step 01c-host-run-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[01-rust-host-run]}"

# 2. managed_control -- Rust Goal/SpecVersion/Run managed-control path.
run_step 02-rust-managed-control "$ROOT/kernel" \
  cargo test --locked --offline --lib managed_control -- --test-threads=1
check_step 02a-managed-control-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[02-rust-managed-control]}"
check_step 02b-managed-control-ok must 'test result: ok' \
  "${STEP_LOG[02-rust-managed-control]}"
check_step 02c-managed-control-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[02-rust-managed-control]}"

# 3. codemode_inspect -- Rust codemode inspection tests.
run_step 03-rust-codemode-inspect "$ROOT/kernel" \
  cargo test --locked --offline --lib codemode_inspect -- --test-threads=1
check_step 03a-codemode-inspect-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[03-rust-codemode-inspect]}"
check_step 03b-codemode-inspect-ok must 'test result: ok' \
  "${STEP_LOG[03-rust-codemode-inspect]}"
check_step 03c-codemode-inspect-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[03-rust-codemode-inspect]}"

# 4. tool_batch -- Guard no-bypass matrix (ToolBatch control, no bypass).
run_step 04-rust-tool-batch-guard "$ROOT/kernel" \
  cargo test --locked --offline --test tool_batch_guard_matrix -- --test-threads=1
check_step 04a-tool-batch-guard-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[04-rust-tool-batch-guard]}"
check_step 04b-tool-batch-guard-ok must 'test result: ok' \
  "${STEP_LOG[04-rust-tool-batch-guard]}"
check_step 04c-tool-batch-guard-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[04-rust-tool-batch-guard]}"

# 5. effect -- effect host principal / direct-write / receipts.
run_step 05-rust-effect-host "$ROOT/kernel" \
  cargo test --locked --offline --lib effect -- --test-threads=1
check_step 05a-effect-host-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[05-rust-effect-host]}"
check_step 05b-effect-host-ok must 'test result: ok' \
  "${STEP_LOG[05-rust-effect-host]}"
check_step 05c-effect-host-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[05-rust-effect-host]}"

# 6. P6 SecretBroker lease use authorization (library and integration coverage).
run_step 06-rust-secret-use-lib "$ROOT/kernel" \
  cargo test --locked --offline --lib secret_use -- --test-threads=1
check_step 06a-secret-use-lib-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[06-rust-secret-use-lib]}"
check_step 06b-secret-use-lib-ok must 'test result: ok' \
  "${STEP_LOG[06-rust-secret-use-lib]}"
check_step 06c-secret-use-lib-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[06-rust-secret-use-lib]}"

run_step 07-rust-secret-use-grant "$ROOT/kernel" \
  cargo test --locked --offline --test secret_use_grant -- --test-threads=1
check_step 07a-secret-use-grant-nonempty must '^running [1-9][0-9]* tests?' \
  "${STEP_LOG[07-rust-secret-use-grant]}"
check_step 07b-secret-use-grant-ok must 'test result: ok' \
  "${STEP_LOG[07-rust-secret-use-grant]}"
check_step 07c-secret-use-grant-no-failed mustnot 'test result: FAILED' \
  "${STEP_LOG[07-rust-secret-use-grant]}"

print_summary
printf 'V1-RUST-VERIFY=PASS steps=%s logs=%s\n' "${#EXPECTED_STEPS[@]}" "${LOG_ROOT#"$ROOT"/}"
exit 0
