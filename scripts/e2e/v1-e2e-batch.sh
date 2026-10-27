#!/usr/bin/env bash
# scripts/e2e/v1-e2e-batch.sh
#
# HorizonCode V1 offline E2E BATCH orchestrator -- the "complete e2e testing"
# one-command deliverable (AGENTS.md section 9: "Real product journey
# (not mocks), complete e2e testing, all features").
#
# Runs ALL HorizonCode offline E2E journeys IN SEQUENCE and reports a single
# combined verdict (V1-E2E-BATCH=PASS|PARTIAL|FAIL) plus a per-journey summary
# table. Self-contained: ROOT/STAMP are derived from ${BASH_SOURCE[0]}, so the
# script never depends on caller env or cwd.
#
# Journeys (fixed order):
#   01  v1-smoke.sh            canonical SA-6 smoke: write tool, cost 0, 401
#                              negative -- the fastest full-server gate, so it
#                              runs FIRST to fail cheap
#   02  v1-mock-journey.sh     offline mock-LLM base journey (no provider
#                              traffic); may not exist yet -> SKIPPED if absent
#   03  v1-cancel-restart.sh   FIN-02: cancel / SIGKILL mid-stream / restart /
#                              no-duplicate-message / no blind retry
#   04  v1-routing-negative.sh DEC-V1-32/36: unreachable pinned route fails
#                              EXPLICITLY, NO hidden fallback (already proven
#                              PASS) -- heavier, runs LAST
#
# ORDERING RATIONALE: cheapest canonical gate first (01), then the base
# mock journey (02), then the destructive restart journey (03, kills its own
# server), then the proven routing negative (04). Destructive/heavy journeys
# run after the cheap gates so a broken tree fails fast on 01 first.
#
# PREREQUISITE: run this AFTER the AgentProfileV2 config fix lands -- the
# journeys boot real `horizoncode serve` instances against the user config and
# assert provider-authority gating, so a pre-fix tree is expected to fail 01/03.
#
# BATCH vs SECTION-9 SEMANTICS (deliberate choice): section 9's
# scripts/verify/v1-final-verify.sh FAIL-FASTS at the first bad step because it
# is a build/typecheck gate. For a BATCH of E2E journeys it is MORE USEFUL to
# CONTINUE PAST a failing journey and report ALL results, so this runner runs
# every journey, records each exit code, then prints one combined summary table
# and marker. A missing journey script is marked SKIPPED (with a note), not
# turned into a batch failure.
#
# VERDICT:
#   PASS     all 4 journeys present AND all passed (exit 0)
#   PARTIAL  every RUN journey passed but >=1 journey script was missing
#            (SKIPPED) -> exit 0 (not a failure; readiness note)
#   FAIL     >=1 journey FAILED -> exit 1
#
# OFFLINE / ZERO-EGRESS: every journey is offline by design (loopback-only
# servers, repo-local mock LLM / closed-port TCP refusals, disabled model
# fetch). Provider API-key env vars are unset for every journey
# (`env -u ...`), so no paid route and no network fetch can run. No provider,
# no npm registry, no Cargo, no remote mutation.
#
# BUN: the pinned repo-local Bun 1.3.14 Linux binary is pinned internally and
# passed to each journey via the literal `env NAME=value` form
# (env BUN=<path> bash <journey>), which is immune to outer-string
# pre-expansion quirks. Journeys run with repo-local TMPDIR (never system temp).
#
# Usage (invoke BY PATH with a $-free outer string -- the known quirk
# pre-expands $VAR inside a `wsl.exe bash -lc "..."` string to empty, so the
# outer invocation must contain NO $ characters; the script itself derives
# ROOT/STAMP/BUN internally and never reads caller env):
#   wsl.exe -d Ubuntu-24.04 -- bash /home/sarvesh/business_Dev/agentx/scripts/e2e/v1-e2e-batch.sh
#   (cwd-independent) -- or, already inside WSL at the repo root:
#   bash scripts/e2e/v1-e2e-batch.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_ROOT="$ROOT/.tmp/e2e/batch-$STAMP"
LOG_DIR="$LOG_ROOT/logs"
TMP_INREPO="$LOG_ROOT/tmp"
SUMMARY_FILE="$LOG_ROOT/summary.txt"

BUN="${BUN:-$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun}"

# Provider credentials must never be exercised by the batch (the journeys
# scrub again internally; this is defense in depth for zero-egress).
ENV_SCRUB=(env
  -u OPENCODE_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY
  -u OPENCODE_GO_API_KEY -u GOOGLE_GENERATIVE_AI_API_KEY
  -u OPENROUTER_API_KEY -u DEEPSEEK_API_KEY -u XAI_API_KEY
  -u GROQ_API_KEY -u COHERE_API_KEY -u MISTRAL_API_KEY)

# ---------------------------------------------------------------- preflight
fail_preflight() {
  printf 'V1-E2E-BATCH PREFLIGHT FAIL: %s\n' "$*" >&2
  exit 2
}

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) : ;;
  *) fail_preflight "must run inside WSL/Linux (repo-local Bun 1.3.14 is a Linux binary); use: wsl.exe -d Ubuntu-24.04 -- bash scripts/e2e/v1-e2e-batch.sh" ;;
esac
[ -d "$ROOT/scripts/e2e" ] || fail_preflight "scripts/e2e/ not found under $ROOT"
[ -x "$BUN" ] || fail_preflight "BUN is not an executable: $BUN (pin the repo-local Bun 1.3.14 or set BUN=/path/to/bun to override)"

# Full expected plan, in order. Journeys whose script does NOT exist are
# recorded as SKIPPED (with a note) and counted in the combined verdict.
JOURNEYS=(
  01-smoke:scripts/e2e/v1-smoke.sh
  02-mock-journey:scripts/e2e/v1-mock-journey.sh
  03-cancel-restart:scripts/e2e/v1-cancel-restart.sh
  04-routing-negative:scripts/e2e/v1-routing-negative.sh
)

PRESENT=0
for entry in "${JOURNEYS[@]}"; do
  rel="${entry#*:}"
  [ -f "$ROOT/$rel" ] && PRESENT=$((PRESENT + 1))
done
[ "$PRESENT" -ge 1 ] || fail_preflight "no journey script found under $ROOT/scripts/e2e (checked: v1-smoke.sh, v1-mock-journey.sh, v1-cancel-restart.sh, v1-routing-negative.sh)"

mkdir -p "$LOG_DIR" "$TMP_INREPO" || fail_preflight "cannot create repo-local log/tmp dirs under $LOG_ROOT"

# ------------------------------------------------------------- bookkeeping
declare -A STEP_EXIT=()
declare -A STEP_LOG=()
declare -A STEP_STATE=()
declare -A STEP_NOTE=()

STEP_INDEX=0
FAIL_COUNT=0
SKIP_COUNT=0

now() { date +%Y-%m-%dT%H:%M:%S%z; }

verdict() {
  if [ "$FAIL_COUNT" -gt 0 ]; then echo FAIL
  elif [ "$SKIP_COUNT" -gt 0 ]; then echo PARTIAL
  else echo PASS
  fi
}

print_summary() {
  local id state rc
  {
    printf '==================== v1-e2e-batch summary (%s) ====================\n' "$STAMP"
    printf '%-24s %-9s %-5s %s\n' "JOURNEY" "RESULT" "EXIT" "LOG / NOTE"
    for id in "${JOURNEYS[@]%%:*}"; do
      state="${STEP_STATE[$id]:-SKIPPED}"
      if [ "$state" = SKIPPED ]; then
        rc="-"
      else
        rc="${STEP_EXIT[$id]:-?}"
      fi
      printf '%-24s %-9s %-5s %s\n' "$id" "$state" "$rc" "${STEP_NOTE[$id]:-${STEP_LOG[$id]:--}}"
    done
    printf 'RESULT: %s -- %s journey(s) passed, %s failed, %s skipped (of %s planned)\n' \
      "$(verdict)" "$(( ${#JOURNEYS[@]} - FAIL_COUNT - SKIP_COUNT ))" "$FAIL_COUNT" "$SKIP_COUNT" "${#JOURNEYS[@]}"
    printf 'logs: %s\n' "${LOG_ROOT#"$ROOT"/}"
  } | tee "$SUMMARY_FILE"
}

# run_step <label> <relpath>
# stdout+stderr -> timestamped repo-local log; exit code recorded; PASS/FAIL
# printed; on failure the log tail is echoed -- but the batch CONTINUES to the
# next journey (see header: reporting ALL results beats fail-fast for E2E).
run_step() {
  local label="$1" rel="$2"
  STEP_INDEX=$((STEP_INDEX + 1))
  local script="$ROOT/$rel"
  local log="$LOG_DIR/${STAMP}-$(printf '%02d' "$STEP_INDEX")-${label}.log"
  local rc=0
  printf '[%s] STEP %s  (env BUN=%s bash %s)\n' "$(now)" "$label" "$BUN" "$rel"
  (
    cd "$ROOT" || exit 1
    # env NAME=value literal form: immune to outer-string $ pre-expansion;
    # repo-local TMPDIR keeps all scratch state inside the repo.
    "${ENV_SCRUB[@]}" env BUN="$BUN" TMPDIR="$TMP_INREPO" TMP="$TMP_INREPO" TEMP="$TMP_INREPO" bash "$script"
  ) >"$log" 2>&1 || rc=$?
  STEP_EXIT["$label"]=$rc
  STEP_LOG["$label"]="${log#"$ROOT"/}"
  if [ "$rc" -eq 0 ]; then
    STEP_STATE["$label"]=PASS
    printf '[%s] STEP %s: PASS (exit 0)  log=%s\n' "$(now)" "$label" "${log#"$ROOT"/}"
    return 0
  fi
  STEP_STATE["$label"]=FAIL
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[%s] STEP %s: FAIL (exit %s)  log=%s  -- continuing to next journey\n' \
    "$(now)" "$label" "$rc" "${log#"$ROOT"/}" >&2
  printf -- '--- %s: last 40 log lines ---\n' "$label" >&2
  tail -n 40 "$log" >&2 2>/dev/null
  printf -- '--- end %s log tail ---\n' "$label" >&2
  return 0   # batch mode: record the failure, keep going
}

# ------------------------------------------------------------------- steps
printf 'v1-e2e-batch: run=%s root=%s bun=%s\n' "$STAMP" "$ROOT" "$BUN"
printf 'all journeys are OFFLINE (loopback-only, zero-egress); provider API keys are unset for every journey\n'

for entry in "${JOURNEYS[@]}"; do
  label="${entry%%:*}"
  rel="${entry#*:}"
  if [ -f "$ROOT/$rel" ]; then
    run_step "$label" "$rel"
  else
    STEP_STATE["$label"]=SKIPPED
    STEP_NOTE["$label"]="SKIPPED: $rel not present"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    printf '[%s] STEP %s: SKIPPED -- %s not present\n' "$(now)" "$label" "$rel" >&2
  fi
done

print_summary

case "$(verdict)" in
  PASS)
    printf 'V1-E2E-BATCH=PASS journeys=%s logs=%s\n' "${#JOURNEYS[@]}" "${LOG_ROOT#"$ROOT"/}"
    exit 0
    ;;
  PARTIAL)
    # Missing journey script(s) only -- every run journey passed. Not a
    # failure; a readiness note until the remaining journey(s) land.
    printf 'V1-E2E-BATCH=PARTIAL skipped=%s (of %s) logs=%s\n' "$SKIP_COUNT" "${#JOURNEYS[@]}" "${LOG_ROOT#"$ROOT"/}"
    exit 0
    ;;
  *)
    printf 'V1-E2E-BATCH=FAIL failed=%s skipped=%s logs=%s\n' "$FAIL_COUNT" "$SKIP_COUNT" "${LOG_ROOT#"$ROOT"/}" >&2
    exit 1
    ;;
esac
