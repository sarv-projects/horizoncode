#!/usr/bin/env bash
# scripts/verify/v1-final-verify.sh
#
# HorizonCode V1 final acceptance batched verifier (section 9 of AGENTS.md).
#
# DRY, fail-closed, repo-local only. Runs the focused acceptance evidence in a
# fixed order, stops at the FIRST failing step with a clear step label, and
# exits non-zero if anything failed. Every step's stdout+stderr lands in its
# own timestamped log under .tmp/final-verify/ (never system temp); a summary
# table of step -> exit code is printed (and saved) at the end.
#
# Steps:
#   01  Overlay visibility audit; focused OpenCode/Core/TUI typechecks with
#       captured fail-closed `error TS` output assertions.
#   02  Focused P1-P8 tests (Guarded Edit/Write, managed-control, RepoIntel,
#       closed DAP/LSP/editor routes, Context policy, WebSearch/CodeMode,
#       SecretBroker and closed provider entry, TUI tail-follow/connect, offline
#       P8 evidence).
#   03  P9 release-readiness synthetic tests (no build, signing, or publish).
#   04  Verify both check-step helpers reject grep errors; shell syntax checks.
#   05  Local CLI -> loopback mock LLM -> Guarded Write E2E. The mock binds only
#       127.0.0.1, is zero-cost, and provider keys are scrubbed; no remote provider
#       call or paid route is used. Rust tests are run separately by
#       `scripts/verify/v1-rust-verify.sh` after this script passes.
#       Every step logs under .tmp/final-verify and stops at first failure.
#
# Environment:
#   BUN  Path to the Bun binary. Defaults to the pinned repo-local
#        Bun 1.3.14 Linux binary; override to test another build.
#        BUN=/path/to/bun bash scripts/verify/v1-final-verify.sh
#
# Provider API keys are unset for every step (`env -u ...`): no paid route or
# remote provider/network call. One local loopback mock LLM is used for CLI E2E.
# No Cargo steps here; run the serial/offline Rust companion only after PASS.
#
# Usage:
#   bash scripts/verify/v1-final-verify.sh          # from inside WSL
#   wsl -d Ubuntu-24.04 -- bash scripts/verify/v1-final-verify.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_ROOT="$ROOT/.tmp/final-verify/$STAMP"
LOG_DIR="$LOG_ROOT/logs"
TMP_INREPO="$LOG_ROOT/tmp"
SUMMARY_FILE="$LOG_ROOT/summary.txt"

BUN="${BUN:-$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun}"
# Spawned CLI/ACP subprocesses resolve `bun` by name, so expose the same binary.
export PATH="$(dirname "$BUN"):$PATH"

# Provider credentials must never be exercised by final verification.
ENV_SCRUB=(env
  -u OPENCODE_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY
  -u OPENCODE_GO_API_KEY -u GOOGLE_GENERATIVE_AI_API_KEY
  -u OPENROUTER_API_KEY -u DEEPSEEK_API_KEY -u XAI_API_KEY
  -u GROQ_API_KEY -u COHERE_API_KEY -u MISTRAL_API_KEY)

# ---------------------------------------------------------------- preflight
fail_preflight() {
  printf 'V1-FINAL-VERIFY PREFLIGHT FAIL: %s\n' "$*" >&2
  exit 2
}

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) : ;;
  *) fail_preflight "must run inside WSL/Linux (repo-local Bun 1.3.14 is a Linux binary); use: wsl -d Ubuntu-24.04 -- bash scripts/verify/v1-final-verify.sh" ;;
esac
command -v python3 >/dev/null 2>&1 || fail_preflight "python3 not found on PATH"
[ -x "$BUN" ] || fail_preflight "BUN is not an executable: $BUN (set BUN=/path/to/bun to override)"
[ -f "$ROOT/packages/horizoncode/package.json" ] || fail_preflight "packages/horizoncode/package.json not found under $ROOT"
[ -f "$ROOT/scripts/perf/test_baseline_evidence.py" ] || fail_preflight "scripts/perf/test_baseline_evidence.py not found under $ROOT"
[ -f "$ROOT/scripts/architecture/audit_overlay_visibility.py" ] || fail_preflight "scripts/architecture/audit_overlay_visibility.py not found under $ROOT"

mkdir -p "$LOG_DIR" "$TMP_INREPO" || fail_preflight "cannot create repo-local log/tmp dirs under $LOG_ROOT"

export TMPDIR="$TMP_INREPO"          # repo-local; never system temp
export TMP="$TMP_INREPO"
export TEMP="$TMP_INREPO"

# ------------------------------------------------------------- bookkeeping
# Full expected plan, in order. Anything declared here but not executed when
# the run stops is reported as SKIPPED in the summary.
EXPECTED_STEPS=(
  01-overlay-visibility
  02-opencode-typecheck
  02b-opencode-no-ts-errors
  02c-core-typecheck
  02d-core-no-ts-errors
  02e-tui-typecheck
  02f-tui-no-ts-errors
  03a-p1-tools
  03b-p2-managed-control
  03c-p3-repo-intel
  03d-p3-core-context
  03e-p4-closed-editor-dap-lsp
  03f-p5-search-codemode
  03g-p6-secretbroker-provider-closed
  03h-p7-opencode-direct-ux
  03i-p7-tui-scroll-connect
  04a-p8-baseline-evidence
  04b-p8-baseline-nonempty
  04c-p8-baseline-ok
  04d-p8-admission-policy
  04e-p8-admission-policy-nonempty
  04f-p8-rc0-budget
  04g-p8-rc0-budget-nonempty
  04h-p8-eval-harness
  04i-p8-eval-harness-nonempty
  04j-p8-eval-harness-ok
  05-p9-release-readiness
  05b-p9-release-readiness-nonempty
  06a-verifier-grep-regression
  06b-shell-syntax
  07-offline-cli-llm-e2e
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
    printf '==================== v1-final-verify summary (%s) ====================\n' "$STAMP"
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
# stdout+stderr -> timestamped repo-local log; exit code recorded; PASS/FAIL
# printed; on failure the log tail is echoed and the run STOPS (fail-closed).
run_step() {
  local label="$1" wd="$2"; shift 2
  STEP_INDEX=$((STEP_INDEX + 1))
  local log="$LOG_DIR/${STAMP}-$(printf '%02d' "$STEP_INDEX")-${label}.log"
  local rc=0
  printf '[%s] STEP %s  (cd %s && %s)\n' "$(now)" "$label" "$wd" "$*"
  (
    cd "$wd" || exit 1
    "${ENV_SCRUB[@]}" TMPDIR="$TMP_INREPO" TMP="$TMP_INREPO" TEMP="$TMP_INREPO" "$@"
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
  printf 'V1-FINAL-VERIFY=FAIL first_failure=%s exit=%s logs=%s\n' "$label" "$rc" "${LOG_ROOT#"$ROOT"/}" >&2
  exit 1
}

# check_step <label> <must|mustnot> <extended-regex> <file>
# Fail-closed assertion against an already-captured step log; recorded in the
# summary table exactly like a run_step.
check_step() {
  local label="$1" mode="$2" pattern="$3" file="$4"
  local grep_rc
  STEP_INDEX=$((STEP_INDEX + 1))
  local rc=1
  if [ -f "$file" ] && { [ "$mode" = must ] || [ "$mode" = mustnot ]; }; then
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
  printf 'V1-FINAL-VERIFY=FAIL first_failure=%s exit=1 logs=%s\n' "$label" "${LOG_ROOT#"$ROOT"/}" >&2
  exit 1
}

# ------------------------------------------------------------------- steps
printf 'v1-final-verify: run=%s root=%s bun=%s\n' "$STAMP" "$ROOT" "$BUN"
printf 'provider API keys are unset for every step; all scratch state is under .tmp/final-verify/\n'

# 1. Overlay visibility audit: all new/modified files must be reviewable.
run_step 01-overlay-visibility "$ROOT" \
  python3 scripts/architecture/audit_overlay_visibility.py

# 2. Focused package typechecks; reject both nonzero exits and latent TS diagnostics.
run_step 02-opencode-typecheck "$ROOT/packages/horizoncode" \
  "$BUN" run typecheck
check_step 02b-opencode-no-ts-errors mustnot 'error TS' \
  "${STEP_LOG[02-opencode-typecheck]}"
run_step 02c-core-typecheck "$ROOT/packages/core" \
  "$BUN" run typecheck
check_step 02d-core-no-ts-errors mustnot 'error TS' \
  "${STEP_LOG[02c-core-typecheck]}"
run_step 02e-tui-typecheck "$ROOT/packages/tui" \
  "$BUN" run typecheck
check_step 02f-tui-no-ts-errors mustnot 'error TS' \
  "${STEP_LOG[02e-tui-typecheck]}"

# 3a. P1 Guarded Edit/Write ordering and P2 managed lifecycle.
run_step 03a-p1-tools "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 120000 \
  test/tool/edit.test.ts test/tool/write.test.ts test/session/tools.test.ts
run_step 03b-p2-managed-control "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 30000 test/session/managed-control.test.ts

# 3b. P3 exact repo freshness/byte budgets and Core symbol/compile policy.
run_step 03c-p3-repo-intel "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 30000 test/tool/repo-tools.test.ts test/tool/repo-intel.test.ts
run_step 03d-p3-core-context "$ROOT/packages/core" \
  "$BUN" test --timeout 30000 test/context-compile-policy.test.ts

# 3c. P4 closed DAP/LSP/editor surfaces: no spawn, auth, or HostKernel dispatch.
run_step 03e-p4-closed-editor-dap-lsp "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 120000 \
  test/lsp/external-editor.test.ts test/lsp/index.test.ts \
  test/dap/tool-surface.test.ts test/dap/host-protocol-client.test.ts

# 3e. P5 WebSearch/CodeMode protocol and turn-loop regressions (offline; readiness closed).
run_step 03f-p5-search-codemode "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 60000 \
  test/tool/websearch.test.ts test/tool/code-mode.test.ts \
  test/tool/code-mode-integration.test.ts test/tool/code-mode-protocol.test.ts \
  test/tool/code-mode-run.test.ts test/tool/code-mode-helper.test.ts

# 3f. P6 secret grants/transport and local provider-denial tests; no live key/provider.
run_step 03g-p6-secretbroker-provider-closed "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 60000 \
  test/auth/credential-use-authorizer.test.ts \
  test/auth/credential-mutation-authorizer.test.ts test/auth/credential-mutation.test.ts \
  test/auth/provider-transport.test.ts test/auth/provider-command.test.ts \
  test/auth/secure-input.test.ts test/auth/direct-free-credential.test.ts \
  test/provider/direct-free-credential.test.ts \
  test/cli/provider-url-auth-disabled.test.ts test/cli/plugin-auth-picker.test.ts \
  test/cli/acp/initialize-auth.test.ts

# 3g. P7 direct UX and mounted TUI scroll/connect behavior.
run_step 03h-p7-opencode-direct-ux "$ROOT/packages/horizoncode" \
  "$BUN" test --timeout 60000 \
  test/session/retry.test.ts test/server/httpapi-v2-direct-profile-map.test.ts
run_step 03i-p7-tui-scroll-connect "$ROOT/packages/tui" \
  "$BUN" test --timeout 200000 \
  test/cli/cmd/tui/session-transcript-scroll.test.tsx \
  test/util/transcript.test.ts test/util/transcript-window.test.ts \
  test/cli/cmd/tui/provider-options.test.ts test/component/dialog-model.test.ts

# 4. P8 Python suites. Every suite must report a positive test count, and the
# baseline suite must additionally report its success marker.
run_step 04a-p8-baseline-evidence "$ROOT/scripts/perf" \
  python3 -m unittest -v test_baseline_evidence
check_step 04b-p8-baseline-nonempty must '^Ran [1-9][0-9]* tests?' \
  "${STEP_LOG[04a-p8-baseline-evidence]}"
check_step 04c-p8-baseline-ok must '^OK$' \
  "${STEP_LOG[04a-p8-baseline-evidence]}"
run_step 04d-p8-admission-policy "$ROOT/scripts/perf" \
  python3 -m unittest discover -s . -p 'test_admission_policy*.py' -v
check_step 04e-p8-admission-policy-nonempty must '^Ran [1-9][0-9]* tests?' \
  "${STEP_LOG[04d-p8-admission-policy]}"
run_step 04f-p8-rc0-budget "$ROOT/scripts/perf" \
  python3 -m unittest -v test_rc0
check_step 04g-p8-rc0-budget-nonempty must '^Ran [1-9][0-9]* tests?' \
  "${STEP_LOG[04f-p8-rc0-budget]}"
run_step 04h-p8-eval-harness "$ROOT/scripts/eval" \
  python3 -m unittest -v test_eval_harness
check_step 04i-p8-eval-harness-nonempty must '^Ran [1-9][0-9]* tests?' \
  "${STEP_LOG[04h-p8-eval-harness]}"
check_step 04j-p8-eval-harness-ok must '^OK$' \
  "${STEP_LOG[04h-p8-eval-harness]}"

# 5. P9 synthetic release/identity tests; no candidate build, signing, or publication.
run_step 05-p9-release-readiness "$ROOT" \
  python3 -m unittest -v scripts.release.test_release_readiness
check_step 05b-p9-release-readiness-nonempty must '^Ran [1-9][0-9]* tests?' \
  "${STEP_LOG[05-p9-release-readiness]}"

# 6. Exercise both real fail-closed check_step helpers, then syntax-check scripts.
run_step 06a-verifier-grep-regression "$ROOT" \
  bash scripts/verify/test-v1-final-verify-check-step.sh
run_step 06b-shell-syntax "$ROOT" \
  bash -c 'bash -n scripts/verify/v1-final-verify.sh && bash -n scripts/verify/v1-rust-verify.sh && bash -n scripts/verify/test-v1-final-verify-check-step.sh'

# 7. Actual CLI -> loopback-only zero-cost mock LLM -> Guarded Write journey.
run_step 07-offline-cli-llm-e2e "$ROOT" \
  env "BUN=$BUN" bash scripts/e2e/v1-smoke.sh
print_summary
printf 'V1-FINAL-VERIFY=PASS steps=%s logs=%s\n' "${#EXPECTED_STEPS[@]}" "${LOG_ROOT#"$ROOT"/}"
exit 0