#!/usr/bin/env bash
# Focused regression for check_step's fail-closed grep exit-status handling.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
VERIFY="$ROOT/scripts/verify/v1-final-verify.sh"
RUST_VERIFY="$ROOT/scripts/verify/v1-rust-verify.sh"
SCRATCH_ROOT="$ROOT/.tmp"
if [ -n "${TMPDIR:-}" ]; then
  TMPDIR_CANDIDATE="$(cd "$TMPDIR" 2>/dev/null && pwd -P || true)"
  case "$TMPDIR_CANDIDATE/" in
    "$ROOT/"*) SCRATCH_ROOT="$TMPDIR_CANDIDATE" ;;
  esac
fi
mkdir -p -- "$SCRATCH_ROOT" || exit 1
TMP="$(mktemp -d "$SCRATCH_ROOT/v1-final-verify-check-step.XXXXXX")" || exit 1
cleanup() {
  rm -f -- "$TMP/no-match.log" "$TMP/grep-error.log" "$TMP/count.log"
  rmdir -- "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

extract_check_step() {
  local source_file="$1" function_name="$2" function_source
  function_source="$(sed -n '/^check_step() {$/,/^}$/p' "$source_file")"
  if [ -z "$function_source" ]; then
    printf 'FAIL: could not extract check_step from %s\n' "$source_file" >&2
    exit 1
  fi
  function_source="${function_source/check_step()/check_step_${function_name}()}"
  eval "$function_source"
}
extract_check_step "$VERIFY" final
extract_check_step "$RUST_VERIFY" rust

assert_static_count_check() {
  local source_file="$1" label="$2" pattern="$3"
  if ! grep -Fq "  $label" "$source_file"; then
    printf 'FAIL: planned step label %s is missing from %s\n' "$label" "$source_file" >&2
    exit 1
  fi
  if ! grep -Fq "check_step $label must '$pattern'" "$source_file"; then
    printf 'FAIL: nonempty count assertion for %s is missing from %s\n' "$label" "$source_file" >&2
    exit 1
  fi
}

assert_static_step_check() {
  local source_file="$1" label="$2" mode="$3" pattern="$4"
  if ! grep -Fq "  $label" "$source_file"; then
    printf 'FAIL: planned step label %s is missing from %s\n' "$label" "$source_file" >&2
    exit 1
  fi
  if ! grep -Fq "check_step $label $mode '$pattern'" "$source_file"; then
    printf 'FAIL: assertion for %s (%s) is missing from %s\n' "$label" "$mode" "$source_file" >&2
    exit 1
  fi
}

assert_static_run_step() {
  local source_file="$1" label="$2" command="$3" workdir="${4:-}"
  if ! grep -Fq "  $label" "$source_file" || ! grep -Fq "run_step $label" "$source_file"; then
    printf 'FAIL: planned run_step %s is missing from %s\n' "$label" "$source_file" >&2
    exit 1
  fi
  if ! grep -Fq "$command" "$source_file"; then
    printf 'FAIL: expected command for %s is missing from %s\n' "$label" "$source_file" >&2
    exit 1
  fi
  if [ -n "$workdir" ] && ! grep -Fq "run_step $label $workdir" "$source_file"; then
    printf 'FAIL: expected working directory for %s is missing from %s\n' "$label" "$source_file" >&2
    exit 1
  fi
}

PY_COUNT='^Ran [1-9][0-9]* tests?'
RUST_COUNT='^running [1-9][0-9]* tests?'
assert_static_count_check "$VERIFY" 04b-p8-baseline-nonempty "$PY_COUNT"
assert_static_count_check "$VERIFY" 04e-p8-admission-policy-nonempty "$PY_COUNT"
assert_static_count_check "$VERIFY" 04g-p8-rc0-budget-nonempty "$PY_COUNT"
assert_static_count_check "$VERIFY" 04i-p8-eval-harness-nonempty "$PY_COUNT"
assert_static_step_check "$VERIFY" 04j-p8-eval-harness-ok must '^OK( \(skipped=[0-9]+\))?$'
assert_static_run_step "$VERIFY" 04h-p8-eval-harness 'python3 -m unittest -v test_eval_harness' '"$ROOT/scripts/eval"'
assert_static_count_check "$VERIFY" 05b-p9-release-readiness-nonempty "$PY_COUNT"
assert_static_count_check "$RUST_VERIFY" 01a-host-run-nonempty "$RUST_COUNT"
assert_static_count_check "$RUST_VERIFY" 02a-managed-control-nonempty "$RUST_COUNT"
assert_static_count_check "$RUST_VERIFY" 03a-codemode-inspect-nonempty "$RUST_COUNT"
assert_static_count_check "$RUST_VERIFY" 04a-tool-batch-guard-nonempty "$RUST_COUNT"
assert_static_count_check "$RUST_VERIFY" 05a-effect-host-nonempty "$RUST_COUNT"
assert_static_count_check "$RUST_VERIFY" 06a-secret-use-lib-nonempty "$RUST_COUNT"
assert_static_step_check "$RUST_VERIFY" 06b-secret-use-lib-ok must 'test result: ok'
assert_static_step_check "$RUST_VERIFY" 06c-secret-use-lib-no-failed mustnot 'test result: FAILED'
assert_static_count_check "$RUST_VERIFY" 07a-secret-use-grant-nonempty "$RUST_COUNT"
assert_static_step_check "$RUST_VERIFY" 07b-secret-use-grant-ok must 'test result: ok'
assert_static_step_check "$RUST_VERIFY" 07c-secret-use-grant-no-failed mustnot 'test result: FAILED'
assert_static_run_step "$RUST_VERIFY" 06-rust-secret-use-lib 'cargo test --locked --offline --lib secret_use -- --test-threads=1'
assert_static_run_step "$RUST_VERIFY" 07-rust-secret-use-grant 'cargo test --locked --offline --test secret_use_grant -- --test-threads=1'

declare -A STEP_EXIT=() STEP_LOG=() STEP_STATE=()
STEP_INDEX=0
FAILED_STEP=""
LOG_ROOT="$TMP"
now() { printf 'test-time'; }
print_summary() { :; }

assert_check_step() {
  local checker="$1" label="$2"
  printf 'clean output\n' > "$TMP/no-match.log"
  "$checker" "regression-$label-no-match" mustnot 'error TS' "$TMP/no-match.log"
  [ "${STEP_STATE[regression-$label-no-match]:-}" = PASS ] || {
    printf 'FAIL: %s did not pass when forbidden pattern was absent\n' "$label" >&2
    exit 1
  }

  printf 'output\n' > "$TMP/grep-error.log"
  if ( "$checker" "regression-$label-grep-error" mustnot '[' "$TMP/grep-error.log" >/dev/null 2>&1 ); then
    printf 'FAIL: %s accepted a grep execution error as an absent pattern\n' "$label" >&2
    exit 1
  fi
}

assert_count_behavior() {
  local checker="$1" label="$2" pattern="$3" positive="$4" zero="$5"
  printf '%s\n' "$positive" > "$TMP/count.log"
  "$checker" "regression-$label-positive" must "$pattern" "$TMP/count.log"
  [ "${STEP_STATE[regression-$label-positive]:-}" = PASS ] || {
    printf 'FAIL: %s rejected a positive test count\n' "$label" >&2
    exit 1
  }

  printf '%s\n' "$zero" > "$TMP/count.log"
  if ( "$checker" "regression-$label-zero" must "$pattern" "$TMP/count.log" >/dev/null 2>&1 ); then
    printf 'FAIL: %s accepted a zero test count\n' "$label" >&2
    exit 1
  fi
}

assert_check_step check_step_final final
assert_check_step check_step_rust rust
assert_count_behavior check_step_final python-count "$PY_COUNT" 'Ran 2 tests in 0.001s' 'Ran 0 tests in 0.000s'
assert_count_behavior check_step_rust rust-count "$RUST_COUNT" 'running 2 tests' 'running 0 tests'
printf 'PASS: both helpers require positive test counts and fail closed on grep errors\n'