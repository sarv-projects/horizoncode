#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# py-task-tui.sh — run the Python tasks through the REAL TUI, typed by a human.
#
#   bench/py-tui/<task>/                  <- FRESH EMPTY arena, the whole world
#   scripts/e2e/py-prompts/<task>.txt     <- pasted whole, one bracketed paste
#
# Same isolated environment as scripts/e2e/py-task.sh (own HOME/XDG/state, the
# models.dev catalog patched to a 32768 output limit, provider nvidia with the
# key from the repo .env) and the same HostKernel asset. The difference is the
# transport: no HTTP message POST. The prompt goes through a PTY into the real
# interactive TUI running in a detached tmux session. This script makes **no
# HTTP requests at all** (not even health checks): the TUI owns its server
# in-process, so there is nothing to poll.
#
# Posture: `--yolo` on the launcher. The TUI creates the direct Session up
# front, PATCHes danger-full-access / approvalPolicy=never onto it and only
# then hands control to the UI, so no Guard approval can stall the turn. The
# evidence line is grepped out of the TUI's stderr into the report.
#
# Usage:
#   bash scripts/e2e/py-task-tui.sh retrykit
#   bash scripts/e2e/py-task-tui.sh auditlog
#   HZ_PY_TUI_KEEP=1 bash scripts/e2e/py-task-tui.sh retrykit   # keep scratch
#   HZ_PY_TUI_TIMEOUT=900 ...                                   # turn bound
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
# Terminal effects need a cgroup owned by the invoking principal; re-exec in a
# delegated systemd user scope when we did not start in one.
hz_ensure_scope "$@"

TASK_NAME="${1:-}"
case "$TASK_NAME" in
  retrykit|auditlog) ;;
  *) printf 'PYTASK_TUI=FAIL\nEVIDENCE_FAIL step=env detail=usage: py-task-tui.sh <retrykit|auditlog>\n' >&2; exit 1 ;;
esac

PROMPT_FILE="$ROOT/scripts/e2e/py-prompts/$TASK_NAME.txt"
GRADER="$ROOT/scripts/e2e/py-hidden/check_$TASK_NAME.py"
TASK_DIR="$ROOT/bench/py-tui/$TASK_NAME"

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/pytui-$RUN_TAG"
LOGS="$E2E/logs/pytui-$TASK_NAME-$RUN_ID"
CAPS="$LOGS/captures"
STATE_DIR="$ROOT/.tmp/st-tui-$RUN_TAG"
PROJECT="$TASK_DIR"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
TURN_TIMEOUT="${HZ_PY_TUI_TIMEOUT:-1200}"
IDLE_NEED="${HZ_PY_TUI_IDLE:-30}"
BOOT_TIMEOUT="${HZ_PY_TUI_BOOT:-90}"
BOOT_ATTEMPTS="${HZ_PY_TUI_BOOT_ATTEMPTS:-3}"

PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
# The catalog keys models by their vendor-prefixed id, so the TUI reference is
# provider "nvidia" + modelID "nvidia/nemotron-...". py-task.sh passes the same
# modelID over HTTP through the provider's own model field.
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
MODEL_REF="$PROVIDER_ID/$MODEL_ID"
case "$PROVIDER_ID" in
  nvidia) KEY_VAR=NVIDIA_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  *) printf 'PYTASK_TUI=FAIL\nEVIDENCE_FAIL step=env detail=unsupported provider %s\n' "$PROVIDER_ID" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }
fatal() { say "PYTASK_TUI=FAIL"; say "EVIDENCE_FAIL step=$1 detail=$2"; exit 1; }

TMUX_BIN="$(command -v tmux 2>/dev/null || true)"
SOCK="pytui-$RUN_TAG"
SESSION="tui"
PANE_PID=""
TURN_START_TS=""

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  if [ -n "$TMUX_BIN" ]; then
    "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true
  fi
  if [ -n "$PANE_PID" ] && kill -0 "$PANE_PID" 2>/dev/null; then
    pkill -TERM -P "$PANE_PID" 2>/dev/null || true
    kill -TERM "$PANE_PID" 2>/dev/null || true
    sleep 0.5
    kill -KILL "$PANE_PID" 2>/dev/null || true
  fi
  [ "${HZ_PY_TUI_KEEP:-0}" = "1" ] || rm -rf "$RUN"
  rm -rf "$STATE_DIR" 2>/dev/null || true
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[ -s "$PROMPT_FILE" ] || fatal env "missing prompt file: $PROMPT_FILE"
[ -f "$GRADER" ] || fatal env "missing grader: $GRADER"
[ -x "$KERNEL_BIN" ] || fatal host-kernel "missing kernel binary $KERNEL_BIN"
[ -n "$TMUX_BIN" ] || fatal env "tmux not found on PATH (tmux is the PTY driver)"
ORIG_HOME="${HOME:-/nonexistent}"
export PATH="$ORIG_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || fatal env "bun is not on PATH (checked $ORIG_HOME/.bun/bin)"
PY="${PY:-$(command -v python3 || true)}"
[ -n "$PY" ] || fatal env "python3 is not on PATH"

ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || fatal env "repo .env missing"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${!KEY_VAR:-}" ] || fatal env "$KEY_VAR is not set after sourcing .env"

mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/config" "$RUN/data" "$RUN/cache" "$LOGS" "$CAPS" "$STATE_DIR"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$STATE_DIR"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-pytui-$RANDOM-$RANDOM}"
say "ENV isolated home=$HOME state=$STATE_DIR"

# ---------------------------------------------------------------------------
# models.dev catalog seeding (same patch as py-task.sh: output limit 32768)
# ---------------------------------------------------------------------------
if [ -z "${HZ_MODELS_SNAPSHOT:-}" ]; then
  HZ_MODELS_SNAPSHOT="$(ls -t "$ORIG_HOME"/.cache/opencode/models*.json 2>/dev/null | grep -v 'meta\.json$' | head -n1)"
fi
if [ -z "${HZ_MODELS_SNAPSHOT:-}" ] || [ ! -f "$HZ_MODELS_SNAPSHOT" ]; then
  fatal catalog "no models.dev snapshot under $ORIG_HOME/.cache/opencode"
fi
mkdir -p "$XDG_CACHE_HOME/opencode"
cp -f "$HZ_MODELS_SNAPSHOT" "$XDG_CACHE_HOME/opencode/models.json"
python3 - "$XDG_CACHE_HOME/opencode/models.json" "$MODEL_ID" "${HZ_CATALOG_OUTPUT_LIMIT:-32768}" <<'PYLIM'
import json, sys
path, model_id, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = json.load(open(path, encoding="utf-8"))
hit = []
for provider in data.values():
    for mid, model in ((provider or {}).get("models") or {}).items():
        if mid != model_id:
            continue
        lim = model.get("limit") or {}
        if int(lim.get("output", 0)) < limit:
            lim["output"] = limit
            model["limit"] = lim
        hit.append(lim.get("output"))
json.dump(data, open(path, "w", encoding="utf-8"))
print("LIMIT model=%s output=%s (requested>=%d)" % (model_id, hit or "NOT-IN-CATALOG", limit))
PYLIM

# The TUI resolves the active model from config before the first prompt; seed
# the isolated global config so the run cannot drift to an unrelated default.
mkdir -p "$XDG_CONFIG_HOME/opencode"
printf '{"$schema":"https://opencode.ai/config.json","model":"%s"}\n' "$MODEL_REF" > "$XDG_CONFIG_HOME/opencode/opencode.json"
say "MODEL $MODEL_REF"

# ---------------------------------------------------------------------------
# HostKernel asset. The TUI server runs in a Worker, so a globalThis manifest
# set by a wrapper would not cross the worker boundary: the env fallbacks the
# supervisor reads are the transport that actually works here.
# ---------------------------------------------------------------------------
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" | cut -d' ' -f1)"
export OPENCODE_HOST_KERNEL_ASSET="$KERNEL_BIN"
export OPENCODE_HOST_KERNEL_MANIFEST="{\"schemaVersion\":1,\"status\":\"available\",\"binaryName\":\"hz-kernel\",\"target\":\"linux-x64-gnu\",\"sha256\":\"$KERNEL_SHA\"}"
say "EVIDENCE kernel_asset=$KERNEL_BIN sha=$KERNEL_SHA"

# ---------------------------------------------------------------------------
# Empty arena: nothing carried in.
# ---------------------------------------------------------------------------
rm -rf "$TASK_DIR"
mkdir -p "$TASK_DIR" || fatal env "could not create arena $TASK_DIR"
say "ARENA task=$TASK_DIR (empty)"

# ---------------------------------------------------------------------------
# Env scrub: only this provider's key and the server password survive.
# ---------------------------------------------------------------------------
SCRUBBED=0
while IFS='=' read -r name _rest; do
  [ -n "$name" ] || continue
  case "$name" in
    *API_KEY*|*APIKEY*|*_TOKEN*|*_SECRET*|*SECRET*|*CREDENTIAL*|*PASSWORD*)
      case "$name" in
        "$KEY_VAR"|OPENCODE_SERVER_PASSWORD) ;;
        *) unset "$name"; SCRUBBED=$((SCRUBBED + 1)) ;;
      esac
      ;;
  esac
done < <(env)
unset HORIZON_DIRECT_FREE_CREDENTIALS OTEL_EXPORTER_OTLP_HEADERS 2>/dev/null || true
say "ENV scrub unset=$SCRUBBED keep=$KEY_VAR,OPENCODE_SERVER_PASSWORD"

export HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1
export HORIZONCODE_LOCAL_CLI=1
export AGENT=1
export OPENCODE=1

# ---------------------------------------------------------------------------
# PTY: detached tmux on a private socket. cwd is packages/horizoncode because Bun
# resolves tsconfig.json from cwd; the arena is the TUI's positional project
# argument (it chdirs there itself).
# ---------------------------------------------------------------------------
TUI_STDERR="$LOGS/tui-stderr.log"
LAUNCH_DISPLAY="cd $ROOT/packages/horizoncode && ./bin/horizoncode --yolo --model $MODEL_REF $PROJECT"
LAUNCH="cd $ROOT/packages/horizoncode && ./bin/horizoncode --yolo --model $MODEL_REF $PROJECT 2>$TUI_STDERR; echo ::TUI_EXIT::\$?; sleep 900"

cap() { "$TMUX_BIN" -L "$SOCK" capture-pane -p -J -t "$SESSION" > "$1" 2>/dev/null || true; }
nudge() {
  "$TMUX_BIN" -L "$SOCK" resize-window -t "$SESSION" -x "$1" -y "$2" 2>/dev/null || true
  "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" Escape 2>/dev/null || true
  "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" -l ' ' 2>/dev/null || true
  "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" BSpace 2>/dev/null || true
}

boot_attempt=0
BOOTED=0
while [ "$boot_attempt" -lt "$BOOT_ATTEMPTS" ]; do
  boot_attempt=$((boot_attempt + 1))
  "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true
  sleep 3
  "$TMUX_BIN" -L "$SOCK" -f /dev/null new-session -d -s "$SESSION" -x 160 -y 50 -c "$ROOT/packages/horizoncode" "$LAUNCH" || {
    say "BOOT attempt $boot_attempt: tmux could not create the session"; continue; }
  say "BOOT attempt $boot_attempt: tmux socket=$SOCK size=160x50"
  i=0
  while [ "$i" -lt "$BOOT_TIMEOUT" ]; do
    i=$((i + 1))
    nudge $((159 + i % 2)) 49
    sleep 1
    cap "$LOGS/pane-boot.txt"
    # The TUI creates its direct Session up front, so the input box may render
    # with an empty (placeholder-less) prompt. The footer hint is the reliable
    # "interactive UI is live" marker.
    if grep -qE 'ctrl\+p commands|Ask anything' "$LOGS/pane-boot.txt" 2>/dev/null; then BOOTED=1; break; fi
    grep -q '::TUI_EXIT::' "$LOGS/pane-boot.txt" 2>/dev/null && break
  done
  if [ "$BOOTED" = "1" ]; then
    say "BOOT ready after $((i))s (attempt $boot_attempt)"
    break
  fi
  say "BOOT attempt $boot_attempt did not paint in ${BOOT_TIMEOUT}s (pane $(wc -c < "$LOGS/pane-boot.txt" 2>/dev/null) bytes)"
  cp -f "$LOGS/pane-boot.txt" "$LOGS/boot-blank-$boot_attempt.txt" 2>/dev/null || true
  sleep 2
done
[ "$BOOTED" = "1" ] || {
  cap "$LOGS/tui-final.txt"
  fatal boot "the real TUI never drew its input box after $BOOT_ATTEMPTS attempts; see $LOGS/boot-blank-*.txt and $TUI_STDERR"
}

# A first-run provider chooser would swallow the paste.
if grep -qE 'Select a connected provider|Connect a provider' "$LOGS/pane-boot.txt" 2>/dev/null; then
  say "BOOT dismissing first-run provider dialog"
  "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" Escape 2>/dev/null || true
  sleep 1
fi
# Clear any stray nudge character out of the input box.
for _ in 1 2 3 4; do "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" BSpace 2>/dev/null || true; done
sleep 1

# ---------------------------------------------------------------------------
# Posture evidence
# ---------------------------------------------------------------------------
POSTURE="flag: --yolo (danger-full-access / approvalPolicy=never)"
POSTURE_EVIDENCE="$(sed -e 's/\x1b\[[0-9;]*m//g' "$TUI_STDERR" 2>/dev/null | grep -i 'permission mode' | head -n1)"
if printf '%s' "$POSTURE_EVIDENCE" | grep -q 'was not applied'; then
  POSTURE="flag: --yolo (NOT applied: $(printf '%s' "$POSTURE_EVIDENCE" | cut -c1-160))"
fi
say "POSTURE $POSTURE"
[ -n "$POSTURE_EVIDENCE" ] && say "POSTURE_EVIDENCE $POSTURE_EVIDENCE"

# ---------------------------------------------------------------------------
# One bracketed paste of the whole prompt, then Enter.
# ---------------------------------------------------------------------------
"$TMUX_BIN" -L "$SOCK" load-buffer -b prompt "$PROMPT_FILE" || fatal prompt "tmux load-buffer failed"
"$TMUX_BIN" -L "$SOCK" paste-buffer -p -b prompt -t "$SESSION" || fatal prompt "tmux paste-buffer failed"
sleep 2
cap "$LOGS/pane-pasted.txt"
PROMPT_LAST="$(grep -v '^[[:space:]]*$' "$PROMPT_FILE" | tail -n1 | cut -c1-48)"
PROMPT_LINES="$(grep -c '' "$PROMPT_FILE" 2>/dev/null || echo '?')"
pasted_ok() {
  # A single-line prompt shows verbatim; a multi-line one is collapsed by the
  # TUI into a "[Pasted ~N lines]" chip, which is the same one-paste delivery.
  grep -Fq -- "$PROMPT_LAST" "$1" 2>/dev/null && return 0
  grep -qE '\[Pasted ~?[0-9]+ line' "$1" 2>/dev/null && return 0
  return 1
}
if ! pasted_ok "$LOGS/pane-pasted.txt"; then
  say "PROMPT not visible after first paste, retrying once"
  "$TMUX_BIN" -L "$SOCK" paste-buffer -p -b prompt -t "$SESSION" || true
  sleep 2
  cap "$LOGS/pane-pasted.txt"
fi
pasted_ok "$LOGS/pane-pasted.txt" || {
  fatal prompt "the pasted prompt never showed up in the input box (tail: $(grep -v '^[[:space:]]*$' "$LOGS/pane-pasted.txt" | tail -3 | tr '\n' ' ' | cut -c1-240))"
}
say "PROMPT pasted ($(wc -c < "$PROMPT_FILE") bytes, ${PROMPT_LINES} lines, one bracketed paste) and confirmed in the input box"

TURN_START_TS="$(date +%s)"
TURN_DEADLINE=$((SECONDS + TURN_TIMEOUT))
"$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" Enter || fatal prompt "tmux send-keys Enter failed"
say "TURN submitted; polling up to ${TURN_TIMEOUT}s for static pane + idle footer"

# Confirm the Enter actually dispatched the prompt: the busy footer ("esc
# interrupt") appears as soon as the turn starts. If the paste chip is still
# sitting in the input box, press Enter once more.
turn_started=0
for _ in $(seq 1 20); do
  sleep 3
  cap "$LOGS/pane-turn-start.txt"
  if grep -qiE 'esc interrupt|Reasoning|Preparing|Succeeded|Failed|Expand output' "$LOGS/pane-turn-start.txt" 2>/dev/null; then
    turn_started=1
    break
  fi
  if grep -qE '\[Pasted ~?[0-9]+ line' "$LOGS/pane-turn-start.txt" 2>/dev/null && ! grep -qi 'esc interrupt' "$LOGS/pane-turn-start.txt"; then
    "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" Enter 2>/dev/null || true
  fi
done
say "TURN started=$turn_started"

# ---------------------------------------------------------------------------
# Wait for the turn to finish: pane static for IDLE_NEED seconds AND no busy
# marker in the footer. Every 10th capture is kept.
# ---------------------------------------------------------------------------
polls=0
stable=0
prev=""
idle=0
exited=0
while :; do
  polls=$((polls + 1))
  sleep 3
  cap "$LOGS/pane-live.txt"
  [ $((polls % 10)) -eq 0 ] && cp -f "$LOGS/pane-live.txt" "$CAPS/capture-$(printf '%03d' "$polls").txt" 2>/dev/null || true
  if grep -q '::TUI_EXIT::' "$LOGS/pane-live.txt" 2>/dev/null; then
    exited=1
    say "TURN the TUI exited mid-turn ($(grep -o '::TUI_EXIT::[0-9]*' "$LOGS/pane-live.txt" | head -n1))"
    break
  fi
  cur="$(md5sum < "$LOGS/pane-live.txt" 2>/dev/null | cut -d' ' -f1)"
  busy=0
  grep -qiE 'esc interrupt|Thinking|Preparing|Working…' "$LOGS/pane-live.txt" 2>/dev/null && busy=1
  if [ "$cur" = "$prev" ] && [ "$busy" = "0" ]; then
    stable=$((stable + 3))
  else
    stable=0
  fi
  prev="$cur"
  if [ "$stable" -ge "$IDLE_NEED" ]; then idle=1; break; fi
  [ "$SECONDS" -ge "$TURN_DEADLINE" ] && break
done
TURN_END_TS="$(date +%s)"
ELAPSED=$((TURN_END_TS - TURN_START_TS))
say "TURN finished idle=$idle exited=$exited elapsed=${ELAPSED}s polls=$polls"

# one confirmation capture before the session goes away
sleep 2
cap "$LOGS/tui-final.txt"
PANE_PID="$("$TMUX_BIN" -L "$SOCK" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -n1)"
"$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true

# ---------------------------------------------------------------------------
# Inventory (read-only) and grading
# ---------------------------------------------------------------------------
python3 - "$TASK_DIR" > "$LOGS/inventory.env" <<'PYINV'
import os, sys
root = sys.argv[1]
files = []
for base, dirs, names in os.walk(root):
    dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "node_modules")]
    for name in names:
        path = os.path.join(base, name)
        rel = os.path.relpath(path, root)
        try: lines = sum(1 for _ in open(path, encoding="utf-8", errors="ignore"))
        except Exception: lines = 0
        files.append((rel, lines))
print("FILES_TOTAL=%d" % len(files))
print("LOC_TOTAL=%d" % sum(n for _, n in files))
print("HAS_INIT=%s" % ("yes" if any(f.endswith("__init__.py") for f, _ in files) else "no"))
print("HAS_README=%s" % ("yes" if any(f.lower().startswith("readme") for f, _ in files) else "no"))
print("HAS_TESTS=%s" % ("yes" if any("test" in f.lower() and f.endswith(".py") for f, _ in files) else "no"))
for f, n in sorted(files):
    print("FILE %s %d" % (f, n))
PYINV

grader_rc=0
# `PYTHONDONTWRITEBYTECODE=1` is required: the graders import the package under
# test, and a normal import would drop `__pycache__` into the arena *before* the
# leftover-junk check runs, which would be the harness failing the agent.
timeout 600 env PYTHONDONTWRITEBYTECODE=1 "$PY" "$GRADER" "$TASK_DIR" > "$LOGS/grader.out" 2>&1 || grader_rc=$?
GRADER_TALLY="$(grep -E "^${TASK_NAME^^}_(CHECKS|PASS|FAIL)=" "$LOGS/grader.out" 2>/dev/null | tr '\n' ' ')"
VERDICT="$(grep -E "^${TASK_NAME^^}=" "$LOGS/grader.out" 2>/dev/null | tail -n1 | cut -d= -f2)"
[ -n "$VERDICT" ] || VERDICT="UNKNOWN"
say "GRADER rc=$grader_rc tally=${GRADER_TALLY:-none}"
say "VERDICT $VERDICT"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
REPORT_DIR="$ROOT/reports/py-tui"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/run-$TASK_NAME-$RUN_ID.md"
getval() { grep "^$1=" "$LOGS/$2" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

{
  printf '# TUI task run — `%s` — %s\n\n' "$TASK_NAME" "$RUN_ID"
  printf -- '- transport: real interactive TUI over a PTY (detached tmux), one bracketed paste\n'
  printf -- '- HTTP used by this runner: **none** (the TUI owns its server in-process; not even a health check)\n'
  printf -- '- launch command: `%s`\n' "$LAUNCH_DISPLAY"
  printf -- '- posture: %s\n' "$POSTURE"
  [ -n "$POSTURE_EVIDENCE" ] && printf -- '- posture evidence (TUI stderr): `%s`\n' "$POSTURE_EVIDENCE"
  printf -- '- model: `%s` (catalog output limit patched to 32768)\n' "$MODEL_REF"
  printf -- '- prompt: `%s` (%s bytes)\n' "$PROMPT_FILE" "$(wc -c < "$PROMPT_FILE")"
  printf -- '- arena: `%s` (recreated empty this run)\n' "$TASK_DIR"
  printf -- '- turn wall clock: %ss (idle=%s exited=%s, bound %ss)\n' "$ELAPSED" "$idle" "$exited" "$TURN_TIMEOUT"
  printf -- '- captures kept: %s (every 10th poll) under `%s`\n\n' "$(ls "$CAPS" 2>/dev/null | wc -l)" "$CAPS"
  printf '## File inventory\n\n- files: %s, LOC: %s\n- package `__init__.py`: %s\n- README: %s\n- tests present: %s\n\n```\n' \
    "$(getval FILES_TOTAL inventory.env)" "$(getval LOC_TOTAL inventory.env)" \
    "$(getval HAS_INIT inventory.env)" "$(getval HAS_README inventory.env)" "$(getval HAS_TESTS inventory.env)"
  grep '^FILE ' "$LOGS/inventory.env" 2>/dev/null || true
  printf '```\n\n## Grader\n\n- command: `PYTHONDONTWRITEBYTECODE=1 python3 scripts/e2e/py-hidden/check_%s.py %s`\n  (bytecode writing is disabled so the grader import itself is not scored as agent leftover junk)\n- rc: %s\n- tally: %s\n\n```\n' \
    "$TASK_NAME" "$TASK_DIR" "$grader_rc" "${GRADER_TALLY:-none}"
  cat "$LOGS/grader.out" 2>/dev/null || true
  printf '```\n\n## Verdict\n\n`%s`\n\n## Final pane\n\n```\n' "$VERDICT"
  sed -e 's/[[:space:]]*$//' "$LOGS/tui-final.txt" 2>/dev/null | grep -v '^$' || true
  printf '```\n'
} > "$REPORT"

say ""
say "REPORT $REPORT"
say "FINAL_PANE $LOGS/tui-final.txt"
say "ARENA $TASK_DIR"
say "PYTASK_TUI=DONE"
exit 0
