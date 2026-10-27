#!/usr/bin/env bash
# scripts/verify/v1-phase10-acceptance.sh
#
# HorizonCode V1 PHASE-10 acceptance orchestrator -- the TOP-LEVEL one-command
# section-9 gate. Sequences the three existing V1 verifiers in dependency
# order and prints ONE combined verdict (V1-PHASE10-ACCEPTANCE=PASS|PARTIAL|
# FAIL) plus a 3-row phase summary table. Self-contained: ROOT/STAMP are
# derived from ${BASH_SOURCE[0]}, so the script never depends on caller env
# or cwd (a known quirk pre-expands $VAR in the outer `wsl.exe bash -lc`
# string to empty, so it must be invoked BY PATH with a $-free outer string).
#
# PHASES (fixed order -- correct dependency order):
#   10a  scripts/verify/v1-final-verify.sh   TS / overlay / P8-Python side.
#                                            Fastest, NO Cargo, fail-fast
#                                            gate -- cheapest signal first.
#                                            expect V1-FINAL-VERIFY=PASS
#   10b  scripts/verify/v1-rust-verify.sh    Rust/Kernel side. SLOW (Cargo
#                                            build; cold can be tens of
#                                            minutes). It owns its OWN
#                                            Cargo-lock preflight (only ONE
#                                            Cargo may run in this repo; it
#                                            REFUSES, exit 2, if a lock is
#                                            busy) -- this orchestrator does
#                                            NOT duplicate that check.
#                                            expect V1-RUST-VERIFY=PASS
#   10c  scripts/e2e/v1-e2e-batch.sh         All 4 offline E2E journeys.
#                                            Boots real `horizoncode serve`
#                                            loopback servers and kills its
#                                            own server in the cancel/restart
#                                            journey, so it runs LAST on a
#                                            settled tree.
#                                            expect V1-E2E-BATCH=PASS
#                                            (PARTIAL = a journey missing)
#
# ORDERING RATIONALE (TS -> Rust -> E2E): 10a is the fastest gate and touches
# no Cargo, so a broken tree fails cheap and first; 10b needs all three Cargo
# locks free and is the slowest phase, so it runs after the fast gates and
# nothing else in this orchestrator touches Cargo (serial-safe); 10c boots
# real servers, so it needs the tree fully settled and runs last.
#
# CONTINUE-PAST-FAILURE (deliberate, same rationale as v1-e2e-batch.sh):
# every phase MUST pass for a PASS verdict, but the orchestrator runs ALL
# THREE phases even after one fails, so a single run yields the FULL picture
# (TS result + Rust result + E2E journeys) instead of stopping at the first
# bad phase. Each phase's stdout+stderr lands in its own timestamped log
# under .tmp/final-verify/<stamp>/phase10-logs/ (never system temp).
#
# PREREQUISITE: run this AFTER the in-flight fixes land -- effects.v1 -> v2,
# managed_control C+D, and the AgentProfileV2 config fix -- and on a SETTLED
# tree (no edits in flight, no other Cargo running, no stray servers). On a
# pre-fix tree 10a and 10c are expected to fail.
#
# VERDICT (one combined marker, printed last):
#   PASS     all three sub-markers PASS (V1-FINAL-VERIFY=PASS,
#            V1-RUST-VERIFY=PASS, V1-E2E-BATCH=PASS)              -> exit 0
#   PARTIAL  no phase FAILED, but at least one phase did not fully
#            pass: V1-E2E-BATCH=PARTIAL (a journey script still
#            missing) or a phase REFUSED by its own sub-preflight
#            (exit 2; 10b reports a busy Cargo lock DISTINCTLY)   -> exit 0
#   FAIL     any phase FAILED: non-zero exit, an explicit =FAIL
#            sub-marker, or a phase that exited 0 WITHOUT printing
#            its =PASS sub-marker (fail-closed on missing marker)
#                                                             -> exit 1
#   (own preflight failure: not Linux/WSL, or a phase script missing/
#    unreadable)                                             -> exit 2
#
# DELEGATED PREFLIGHT ONLY: this orchestrator checks just that it runs on
# Linux/WSL and that all three phase scripts exist and are readable. Every
# deeper preflight (python3/Bun, Cargo locks + free disk, journey scripts)
# belongs to the sub-scripts and is NOT duplicated here. A sub-preflight
# refusal (exit 2) is recorded as REFUSED and reported distinctly in the
# summary table -- never as PASS.
#
# OFFLINE / ZERO-EGRESS: every phase scrubs provider API keys internally
# (`env -u ...`) and pins TMPDIR repo-local itself; this orchestrator passes
# NO caller env through. 10b uses `--locked --offline` Cargo only; no network,
# no npm registry, no paid calls.
#
# Usage (invoke BY PATH with a $-free outer string -- the known quirk
# pre-expands $VAR inside a `wsl.exe bash -lc "..."` string to empty, so the
# outer invocation must contain NO $ characters; this script derives
# ROOT/STAMP internally and never reads caller env):
#   wsl.exe -d Ubuntu-24.04 -- bash /home/sarvesh/business_Dev/agentx/scripts/verify/v1-phase10-acceptance.sh
#   (cwd-independent) -- or, already inside WSL at the repo root:
#   bash scripts/verify/v1-phase10-acceptance.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_ROOT="$ROOT/.tmp/final-verify/$STAMP"
LOG_DIR="$LOG_ROOT/phase10-logs"
SUMMARY_FILE="$LOG_ROOT/summary-phase10.txt"

# ---------------------------------------------------------------- preflight
fail_preflight() {
  printf 'V1-PHASE10-ACCEPTANCE PREFLIGHT FAIL: %s\n' "$*" >&2
  exit 2
}

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) : ;;
  *) fail_preflight "must run inside WSL/Linux (repo verifiers drive Linux Bun/Cargo/servers); use: wsl.exe -d Ubuntu-24.04 -- bash /home/sarvesh/business_Dev/agentx/scripts/verify/v1-phase10-acceptance.sh" ;;
esac

# Full expected plan, in order: label:relpath. Deeper preflights are owned by
# the sub-scripts (10b owns the Cargo-lock check); here we only verify the
# scripts themselves are present and readable, fail-closed.
PHASES=(
  10a-verify-ts:scripts/verify/v1-final-verify.sh
  10b-verify-rust:scripts/verify/v1-rust-verify.sh
  10c-e2e-batch:scripts/e2e/v1-e2e-batch.sh
)

for entry in "${PHASES[@]}"; do
  rel="${entry#*:}"
  [ -f "$ROOT/$rel" ] || fail_preflight "phase script not found: $rel (under $ROOT)"
  [ -r "$ROOT/$rel" ] || fail_preflight "phase script not readable: $rel (under $ROOT)"
done

mkdir -p "$LOG_DIR" || fail_preflight "cannot create repo-local log dir under $LOG_ROOT"

# ------------------------------------------------------------- bookkeeping
declare -A PHASE_EXIT=()
declare -A PHASE_LOG=()
declare -A PHASE_STATE=()
declare -A PHASE_NOTE=()

PHASE_INDEX=0
PASS_COUNT=0
PARTIAL_COUNT=0   # PARTIAL (e2e journey missing) + REFUSED (sub-preflight)
FAIL_COUNT=0

now() { date +%Y-%m-%dT%H:%M:%S%z; }

verdict() {
  if [ "$FAIL_COUNT" -gt 0 ]; then echo FAIL
  elif [ "$PASS_COUNT" -eq "${#PHASES[@]}" ]; then echo PASS
  else echo PARTIAL
  fi
}

print_summary() {
  local id state
  {
    printf '==================== v1-phase10-acceptance summary (%s) ====================\n' "$STAMP"
    printf '%-16s %-9s %-5s %s\n' "PHASE" "RESULT" "EXIT" "LOG / NOTE"
    for id in "${PHASES[@]%%:*}"; do
      state="${PHASE_STATE[$id]:-NOT-RUN}"
      if [ "$state" = NOT-RUN ]; then
        printf '%-16s %-9s %-5s %s\n' "$id" "$state" "-" "NOT RUN (orchestrator ended early)"
      else
        printf '%-16s %-9s %-5s %s\n' "$id" "$state" "${PHASE_EXIT[$id]:-?}" "${PHASE_NOTE[$id]:-${PHASE_LOG[$id]:--}}"
      fi
    done
    printf 'RESULT: %s -- %s passed, %s partial/refused, %s failed (of %s phases)\n' \
      "$(verdict)" "$PASS_COUNT" "$PARTIAL_COUNT" "$FAIL_COUNT" "${#PHASES[@]}"
    printf 'logs: %s\n' "${LOG_ROOT#"$ROOT"/}"
  } | tee "$SUMMARY_FILE"
}

# run_phase <label> <script_relpath>
# Runs ONE sub-verifier BY PATH (`bash "$ROOT/<relpath>"`) from the repo root,
# stdout+stderr -> timestamped repo-local phase10-logs/ file, exit code
# recorded, and the sub-marker printed by that verifier grepped out of the
# log (the exit code alone cannot tell V1-E2E-BATCH=PARTIAL (exit 0) apart
# from PASS). Unlike the section-9 build gate's fail-fast run_step, this is
# BATCH mode: a failing phase's log tail is echoed, the failure is recorded,
# and the run CONTINUES to the next phase for the full picture (header).
run_phase() {
  local label="$1" rel="$2"
  PHASE_INDEX=$((PHASE_INDEX + 1))
  local script="$ROOT/$rel"
  local log="$LOG_DIR/${STAMP}-$(printf '%02d' "$PHASE_INDEX")-${label}.log"
  local marker=""
  case "$label" in
    10a-verify-ts)   marker="V1-FINAL-VERIFY" ;;
    10b-verify-rust) marker="V1-RUST-VERIFY" ;;
    10c-e2e-batch)   marker="V1-E2E-BATCH" ;;
  esac
  local rc=0
  printf '[%s] PHASE %s  (bash %s)\n' "$(now)" "$label" "$rel"
  (
    cd "$ROOT" || exit 1
    bash "$script"
  ) >"$log" 2>&1 || rc=$?
  PHASE_EXIT["$label"]=$rc
  PHASE_LOG["$label"]="${log#"$ROOT"/}"

  # Sub-preflight REFUSAL (fail-closed exit 2): the phase never ran. Report
  # DISTINCTLY -- 10b refuses when a Cargo lock is busy (another Cargo is
  # running) -- and count it in the PARTIAL bucket, never as PASS.
  if [ "$rc" -eq 2 ]; then
    PHASE_STATE["$label"]=REFUSED
    PARTIAL_COUNT=$((PARTIAL_COUNT + 1))
    if grep -q 'Cargo lock is BUSY' "$log" 2>/dev/null; then
      PHASE_NOTE["$label"]="REFUSED: BUSY Cargo lock (another Cargo running) -- see ${log#"$ROOT"/}"
    else
      PHASE_NOTE["$label"]="REFUSED: sub-preflight exit 2 -- see ${log#"$ROOT"/}"
    fi
    printf '[%s] PHASE %s: REFUSED (sub-preflight exit 2)  log=%s  -- continuing to next phase\n' \
      "$(now)" "$label" "${log#"$ROOT"/}" >&2
    printf -- '--- %s: last 40 log lines ---\n' "$label" >&2
    tail -n 40 "$log" >&2 2>/dev/null
    printf -- '--- end %s log tail ---\n' "$label" >&2
    return 0   # batch mode: record the refusal, keep going
  fi

  # Classify from the sub-marker; fail-closed on rc=0 with NO marker.
  if grep -q "^${marker}=PASS" "$log" 2>/dev/null; then
    PHASE_STATE["$label"]=PASS
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '[%s] PHASE %s: PASS (%s=PASS, exit 0)  log=%s\n' \
      "$(now)" "$label" "$marker" "${log#"$ROOT"/}"
    return 0
  fi
  if grep -q "^${marker}=PARTIAL" "$log" 2>/dev/null; then
    PHASE_STATE["$label"]=PARTIAL
    PARTIAL_COUNT=$((PARTIAL_COUNT + 1))
    PHASE_NOTE["$label"]="${marker}=PARTIAL -- see ${log#"$ROOT"/}"
    printf '[%s] PHASE %s: PARTIAL (%s=PARTIAL, exit 0)  log=%s  -- continuing to next phase\n' \
      "$(now)" "$label" "$marker" "${log#"$ROOT"/}" >&2
    printf -- '--- %s: last 40 log lines ---\n' "$label" >&2
    tail -n 40 "$log" >&2 2>/dev/null
    printf -- '--- end %s log tail ---\n' "$label" >&2
    return 0   # batch mode: a missing e2e journey is a readiness note, keep going
  fi

  # FAIL: explicit =FAIL marker, non-zero exit, or rc=0 with no sub-marker.
  PHASE_STATE["$label"]=FAIL
  FAIL_COUNT=$((FAIL_COUNT + 1))
  if ! grep -q "^${marker}=" "$log" 2>/dev/null; then
    PHASE_NOTE["$label"]="FAIL: no ${marker}= sub-marker printed (exit $rc) -- see ${log#"$ROOT"/}"
  fi
  printf '[%s] PHASE %s: FAIL (exit %s, expected %s=PASS)  log=%s  -- continuing to next phase\n' \
    "$(now)" "$label" "$rc" "$marker" "${log#"$ROOT"/}" >&2
  printf -- '--- %s: last 40 log lines ---\n' "$label" >&2
  tail -n 40 "$log" >&2 2>/dev/null
  printf -- '--- end %s log tail ---\n' "$label" >&2
  return 0   # batch mode: record the failure, keep going
}

# ------------------------------------------------------------------- steps
printf 'v1-phase10-acceptance: run=%s root=%s\n' "$STAMP" "$ROOT"
printf 'phase order: 10a TS (no Cargo) -> 10b Rust (Cargo; owns its own lock preflight) -> 10c E2E (boots servers, settled tree)\n'
printf 'all three phases run even past a failure for the full picture; logs land under .tmp/final-verify/%s/phase10-logs/\n' "$STAMP"

# 1. TS / overlay / P8-Python side (fastest, no Cargo).
run_phase 10a-verify-ts scripts/verify/v1-final-verify.sh

# 2. Rust/Kernel side (slow; refuses via its own preflight if a Cargo lock is
#    busy -- reported distinctly above as REFUSED, not duplicated here).
run_phase 10b-verify-rust scripts/verify/v1-rust-verify.sh

# 3. Offline E2E journey batch (boots real servers; PARTIAL = a journey
#    script still missing).
run_phase 10c-e2e-batch scripts/e2e/v1-e2e-batch.sh

print_summary

case "$(verdict)" in
  PASS)
    printf 'V1-PHASE10-ACCEPTANCE=PASS phases=%s logs=%s\n' "${#PHASES[@]}" "${LOG_ROOT#"$ROOT"/}"
    exit 0
    ;;
  PARTIAL)
    # No phase FAILED, but at least one phase did not fully pass: a missing
    # e2e journey (V1-E2E-BATCH=PARTIAL) or a sub-preflight REFUSAL (exit 2,
    # e.g. 10b's busy Cargo lock). Not a failure; a readiness note.
    printf 'V1-PHASE10-ACCEPTANCE=PARTIAL passed=%s partial_or_refused=%s (of %s) logs=%s\n' \
      "$PASS_COUNT" "$PARTIAL_COUNT" "${#PHASES[@]}" "${LOG_ROOT#"$ROOT"/}"
    exit 0
    ;;
  *)
    printf 'V1-PHASE10-ACCEPTANCE=FAIL passed=%s partial_or_refused=%s failed=%s (of %s) logs=%s\n' \
      "$PASS_COUNT" "$PARTIAL_COUNT" "$FAIL_COUNT" "${#PHASES[@]}" "${LOG_ROOT#"$ROOT"/}" >&2
    exit 1
    ;;
esac
