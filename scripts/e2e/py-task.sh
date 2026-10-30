#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Python task journey: HorizonCode builds a package from scratch.
#
#   bench/py/<task>/                 <- EMPTY arena, the agent's whole world
#   scripts/e2e/py-prompts/<task>.txt <- the prompt, handed over verbatim
#
# This script only builds the arena, boots the real server, sends the prompt,
# records the trace, and stops. It does not implement, hint, or repair
# anything the agent produces, and it never touches the arena after the run
# except to read it.
#
# Usage:
#   bash scripts/e2e/py-task.sh retrykit
#   bash scripts/e2e/py-task.sh auditlog
#   HZ_PY_KEEP=1 bash scripts/e2e/py-task.sh retrykit     # keep scratch
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

TASK_NAME="${1:-}"
case "$TASK_NAME" in
  retrykit|auditlog) ;;
  *) printf 'PYTASK=FAIL\nEVIDENCE_FAIL step=env detail=usage: py-task.sh <retrykit|auditlog>\n' >&2; exit 1 ;;
esac

PROMPT_FILE="$ROOT/scripts/e2e/py-prompts/$TASK_NAME.txt"
TASK_DIR="$ROOT/bench/py/$TASK_NAME"

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/pyt-$RUN_TAG"
LOGS="$E2E/logs/pytask-$TASK_NAME-$RUN_ID"
STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
PROJECT="$TASK_DIR"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
SERVE_MODE="${HZ_SERVE_MODE:-source}"
PROMPT_TIMEOUT="${HZ_PY_TIMEOUT:-5400}"

PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
case "$PROVIDER_ID" in
  nvidia) KEY_VAR=NVIDIA_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  *) printf 'PYTASK=FAIL\nEVIDENCE_FAIL step=env detail=unsupported provider %s\n' "$PROVIDER_ID" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }
fatal() { say "PYTASK=FAIL"; say "EVIDENCE_FAIL step=$1 detail=$2"; exit 1; }

SERVER_PID=""
BASE=""
AUTH=""
SID=""

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    pkill -KILL -P "$SERVER_PID" 2>/dev/null || true
  fi
  [ "${HZ_PY_KEEP:-0}" = "1" ] || rm -rf "$RUN"
  rm -rf "$STATE_HOME_OVERRIDE" 2>/dev/null || true
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[ -s "$PROMPT_FILE" ] || fatal env "missing prompt file: $PROMPT_FILE"
[ -x "$KERNEL_BIN" ] || fatal host-kernel "missing kernel binary $KERNEL_BIN"
ORIG_HOME="${HOME:-/nonexistent}"
export PATH="$ORIG_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || fatal env "bun is not on PATH"
PY="${PY:-$(command -v python3 || true)}"
[ -n "$PY" ] || fatal env "python3 is not on PATH"

ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || fatal env "repo .env missing"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${!KEY_VAR:-}" ] || fatal env "$KEY_VAR is not set after sourcing .env"

mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/config" "$RUN/data" "$RUN/cache" "$LOGS" "$STATE_HOME_OVERRIDE"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$STATE_HOME_OVERRIDE"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-py-$RANDOM-$RANDOM}"
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
export HZ_E2E_BOOTSTRAP_NEMOTRON=1

# shellcheck source=lib/bootstrap-horizoncode-config.sh
. "$HZ_LIB_DIR/bootstrap-horizoncode-config.sh"
hz_bootstrap_horizoncode_config

HOST_SOCK="$STATE_HOME_OVERRIDE/opencode/session-observer/ses_0123456789abcdefghij.sock"
if [ "${#HOST_SOCK}" -ge 108 ]; then
  fatal env "observer socket path is ${#HOST_SOCK} bytes (>=108): $STATE_HOME_OVERRIDE"
fi

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

# ---------------------------------------------------------------------------
# Empty arena: nothing is carried in, nothing is carried out.
# ---------------------------------------------------------------------------
rm -rf "$TASK_DIR"
mkdir -p "$TASK_DIR" || fatal env "could not create arena $TASK_DIR"
say "ARENA task=$TASK_DIR (empty)"

# Coverage gate. The ledger is derived from the brief by the harness, so the set
# of requirements is fixed before the agent reads anything: it cannot forget one,
# and it cannot renumber the brief to match what it happened to build. The agent
# may fill in each row's check; only the harness runs them.
if [ "${HZ_SPEC_LEDGER:-0}" = "1" ]; then
  "$PY" "$ROOT/scripts/spec/spec-ledger.py" --scaffold "$PROMPT_FILE" \
    --out "$TASK_DIR/.opencode/SPEC.json" > "$LOGS/scaffold.out" 2>&1 \
    || fatal spec-ledger "could not scaffold the ledger: $(tail -2 "$LOGS/scaffold.out")"
  say "LEDGER $(head -1 "$LOGS/scaffold.out")"
fi

# ---------------------------------------------------------------------------
# HostKernel wrapper (source mode)
# ---------------------------------------------------------------------------
SERVE_BIN=""
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" | cut -d' ' -f1)"
python3 - "$RUN/kernel-wrapper.ts" "$KERNEL_BIN" "$KERNEL_SHA" "$ROOT/packages/horizoncode/src/index.ts" "$PROJECT" <<'PYWRAP'
import json, sys
out, asset, sha, entry, project = sys.argv[1:6]
with open(out, "w", encoding="utf-8") as f:
    f.write("globalThis.OPENCODE_HOST_KERNEL_MANIFEST = JSON.stringify({\n")
    f.write("  schemaVersion: 1,\n  status: \"available\",\n  binaryName: \"hz-kernel\",\n")
    f.write("  target: \"linux-\" + process.arch + \"-gnu\",\n")
    f.write("  sha256: %s,\n})\n" % json.dumps(sha))
    f.write("globalThis.OPENCODE_HOST_KERNEL_ASSET = %s\n" % json.dumps(asset))
    f.write("process.chdir(%s)\n" % json.dumps(project))
    f.write("await import(%s)\n" % json.dumps(entry))
PYWRAP
[ -s "$RUN/kernel-wrapper.ts" ] || fatal host-kernel "could not write the kernel wrapper"
say "EVIDENCE serve_mode=source kernel_sha=$KERNEL_SHA"

# ---------------------------------------------------------------------------
# Env scrub
# ---------------------------------------------------------------------------
SCRUB=()
while IFS='=' read -r name _rest; do
  [ -n "$name" ] || continue
  case "$name" in
    *API_KEY*|*APIKEY*|*_TOKEN*|*_SECRET*|*SECRET*|*CREDENTIAL*|*PASSWORD*)
      case "$name" in
        "$KEY_VAR"|OPENCODE_SERVER_PASSWORD) ;;
        *) SCRUB+=(-u "$name") ;;
      esac
      ;;
  esac
done < <(env)
SCRUB+=(-u HORIZON_DIRECT_FREE_CREDENTIALS -u OTEL_EXPORTER_OTLP_HEADERS)
say "ENV scrub flags=${#SCRUB[@]} keep=$KEY_VAR,OPENCODE_SERVER_PASSWORD"

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
start_server() {
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  BASE="http://127.0.0.1:$port"
  : > "$LOGS/serve.log"
  ( cd "$ROOT" && exec env "${SCRUB[@]}" \
      HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 HORIZONCODE_LOCAL_CLI=1 \
      "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" --print-logs serve --hostname 127.0.0.1 --port "$port" ) >>"$LOGS/serve.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 240); do
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    if curl -fsS --max-time 2 "$BASE/global/health" -H "Authorization: $AUTH" > "$LOGS/health.json" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  if start_server; then break; fi
  say "SERVER attempt $attempt failed"; tail -c 500 "$LOGS/serve.log" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
done
[ -n "$SERVER_PID" ] || fatal server "serve did not become healthy (see $LOGS/serve.log)"
say "server: pid=$SERVER_PID base=$BASE"

create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d "{\"title\":\"pytask-$TASK_NAME\"}" 2>/dev/null || echo 000)
[ "$create_status" = "200" ] || fatal session-create "HTTP $create_status"
SID=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("id",""))' "$LOGS/session.json" 2>/dev/null || true)
[ -n "$SID" ] || fatal session-create "no session id"
say "session=$SID"

mode_rev=""
for _ in 1 2 3 4 5; do
  raw=$(curl -sS -i --max-time 20 -H "Authorization: $AUTH" \
    "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null || true)
  mode_rev=$(printf '%s' "$raw" | grep -o '"revision":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "$mode_rev" ] && break
  sleep 2
done
[ -n "$mode_rev" ] || fatal permission-mode "no revision in mode read"
mode_patch=$(curl -sS --max-time 20 -o "$LOGS/mode-patch.json" -w '%{http_code}' \
  -X PATCH -H "Authorization: $AUTH" -H 'content-type: application/json' \
  "$BASE/config/direct-session-permission-mode?sessionID=$SID" \
  -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$mode_rev\"}" \
  2>/dev/null || echo 000)
[ "$mode_patch" = "200" ] || fatal permission-mode "PATCH HTTP $mode_patch: $(head -c 300 "$LOGS/mode-patch.json")"
say "mode: danger-full-access / approvalPolicy=never (rev=$mode_rev)"

# ---------------------------------------------------------------------------
# The prompt, verbatim
# ---------------------------------------------------------------------------
python3 - "$PROMPT_FILE" "$PROVIDER_ID" "$MODEL_ID" "$PY" > "$LOGS/prompt-request.json" <<'PYPROMPT'
import json, os, sys
prompt_file, provider, model, py = sys.argv[1:5]
text = open(prompt_file, encoding="utf-8").read()
text += "\n\nWorking directory: this is it. Everything you deliver lives here.\n"
text += "Python 3.12 is on PATH as `python3` (also `%s`). Use only the standard library.\n" % py
if os.environ.get("HZ_SPEC_LEDGER") == "1":
    text += (
        "\nA spec ledger already exists at .opencode/SPEC.json. It has one row per numbered "
        "requirement in the brief above, already numbered and worded, so the requirement count is "
        "fixed before you start. For every row, replace \"check\": null with a check the harness "
        "can run: \"check\": {\"command\": \"<shell command that exits 0 only if that requirement "
        "is genuinely met>\"}. Do not change `id` or `text`, and do not delete rows. If a requirement "
        "truly cannot be checked by a command, set \"waived\": {\"reason\": \"...\"}. You are not "
        "graded on your own description of the work: only those commands decide coverage.\n"
    )
print(json.dumps({
    "model": {"providerID": provider, "modelID": model},
    "parts": [{"type": "text", "text": text}],
}))
PYPROMPT
[ -s "$LOGS/prompt-request.json" ] || fatal prompt "could not build the prompt request"

T0=$(python3 -c 'import time; print(time.time())')
say "prompt: sending to $PROVIDER_ID/$MODEL_ID"
prompt_status=$(curl -sS --max-time "$PROMPT_TIMEOUT" -o "$LOGS/prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/prompt-request.json" 2>/dev/null || echo 000)
[ "$prompt_status" = "200" ] || fatal prompt-http "HTTP $prompt_status: $(head -c 400 "$LOGS/prompt-response.json")"

deadline=$((SECONDS + PROMPT_TIMEOUT))
state=""
while :; do
  curl -sS --max-time 15 "$BASE/session/$SID/message?limit=400" -H "Authorization: $AUTH" \
    -o "$LOGS/messages.json" 2>/dev/null || true
  state=$(python3 - "$LOGS/messages.json" <<'PYSTATE' 2>/dev/null || true
import json,sys
try: data=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception: print("waiting"); raise SystemExit
msgs = data if isinstance(data,list) else (data.get("messages") or data.get("data") or [])
asst=[m for m in msgs if isinstance(m,dict) and isinstance(m.get("info"),dict) and m["info"].get("role")=="assistant"]
if not asst: print("waiting"); raise SystemExit
info=asst[-1]["info"]; t=info.get("time") or {}
print("done" if (t.get("completed") or info.get("finish") is not None) else "running")
PYSTATE
)
  [ "$state" = "done" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 5
done
T1=$(python3 -c 'import time; print(time.time())')
ElapsedSec=$(python3 -c "print(round($T1-$T0,1))")
say "prompt: finished state=${state:-unknown} elapsed=${ElapsedSec}s"

# ---------------------------------------------------------------------------
# Trace
# ---------------------------------------------------------------------------
python3 - "$LOGS/messages.json" "$LOGS/trace.txt" > "$LOGS/trace.env" <<'PYTRACE'
import json, re, sys, collections
src, out_path = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
counts = collections.Counter(); errors = collections.Counter(); messages = collections.Counter()
lines = []
step = 0
for m in msgs:
    if not isinstance(m, dict): continue
    for p in (m.get("parts") or []):
        if not isinstance(p, dict) or p.get("type") != "tool": continue
        step += 1
        name = p.get("tool") or ""
        st = p.get("state") if isinstance(p.get("state"), dict) else {}
        status = st.get("status") or "unknown"
        inp = st.get("input")
        try: blob = json.dumps(inp, ensure_ascii=False)
        except Exception: blob = str(inp)
        blob = blob.replace("\n", " ")[:400]
        counts[name] += 1
        if status != "completed":
            errors["%s:%s" % (name, status)] += 1
            detail = st.get("error")
            if isinstance(detail, dict):
                detail = detail.get("message") or json.dumps(detail, ensure_ascii=False)
            detail = re.sub(r"[0-9a-f]{8,}", "<hex>", str(detail or "")).replace("\n", " ")[:110]
            messages[(name, detail)] += 1
        lines.append("%03d %-18s %-10s %s" % (step, name, status, blob))
open(out_path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("TOOL_CALLS=%d" % step)
for name, n in sorted(counts.items(), key=lambda kv: -kv[1]):
    print("TOOL_%s=%d" % (name.replace(".", "_").replace("-", "_"), n))
print("TOOL_ERRORS=%d" % sum(errors.values()))
for name, n in sorted(errors.items(), key=lambda kv: -kv[1])[:12]:
    print("TOOL_ERR_%s=%d" % (name.replace(".", "_").replace(":", "_").replace("-", "_"), n))
for (name, detail), n in sorted(messages.items(), key=lambda kv: -kv[1])[:12]:
    print("TOOL_ERRMSG %d %s :: %s" % (n, name, detail))
PYTRACE

# Stop the agent's server: the build window is over.
if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
  pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
fi
SERVER_PID=""

# ---------------------------------------------------------------------------
# Inventory (read-only)
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
print("HAS_PYPROJECT=%s" % ("yes" if any(f == "pyproject.toml" for f, _ in files) else "no"))
print("HAS_TESTS=%s" % ("yes" if any("test" in f.lower() and f.endswith(".py") for f, _ in files) else "no"))
for f, n in sorted(files):
    print("FILE %s %d" % (f, n))
PYINV

# ---------------------------------------------------------------------------
# Observational grading: run whatever the agent left behind. No repair.
# ---------------------------------------------------------------------------
# `unittest discover` only recurses into importable packages, so a plain
# tests/ directory at the arena root is invisible to a bare discovery run.
# Try the layouts an agent actually produces, in order, and keep the first
# one that finds tests.
agent_rc=5
: > "$LOGS/agent-tests.out"
for root in tests test . ; do
  [ -d "$TASK_DIR/$root" ] || [ "$root" = "." ] || continue
  ( cd "$TASK_DIR" && PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 PYTHONPATH=. \
      timeout 600 "$PY" -m unittest discover -s "$root" -v > "$LOGS/agent-tests.out" 2>&1 )
  agent_rc=$?
  if grep -qE "^Ran [1-9][0-9]* test" "$LOGS/agent-tests.out" 2>/dev/null; then break; fi
done

python3 - "$LOGS/agent-tests.out" > "$LOGS/agent-tests.env" <<'PYUT'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
ran = re.search(r"^Ran (\d+) test", text, re.M)
ok = re.search(r"^OK(?: \((.*?)\))?\s*$", text, re.M)
fail = re.search(r"^FAILED \((.*?)\)\s*$", text, re.M)
print("AGENT_RAN=%s" % (ran.group(1) if ran else "-"))
print("AGENT_VERDICT=%s" % ("OK" if ok else ("FAILED" if fail else "NO-SUITE")))
if fail: print("AGENT_FAILURE=%s" % fail.group(1))
tail = "\n".join([l for l in text.splitlines() if l.strip()][-8:])
print("AGENT_TAIL<<EOF"); print(tail); print("EOF")
PYUT

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
REPORT_DIR="$ROOT/reports/py"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/run-$TASK_NAME-$RUN_ID.md"
getval() { grep "^$1=" "$LOGS/$2" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

{
  printf '# Python task run — `%s` — %s\n\n' "$TASK_NAME" "$RUN_ID"
  printf -- '- prompt: `%s` (%s bytes)\n- provider/model: `%s/%s`\n- wall clock: %ss\n- tool calls: %s\n- tool errors: %s\n\n' \
    "$PROMPT_FILE" "$(wc -c < "$PROMPT_FILE")" "$PROVIDER_ID" "$MODEL_ID" "$ElapsedSec" \
    "$(getval TOOL_CALLS trace.env)" "$(getval TOOL_ERRORS trace.env)"
  printf '## Deliverable\n\n- files: %s, LOC: %s\n- package `__init__.py`: %s\n- README: %s\n- pyproject.toml: %s\n- tests present: %s\n\n' \
    "$(getval FILES_TOTAL inventory.env)" "$(getval LOC_TOTAL inventory.env)" \
    "$(getval HAS_INIT inventory.env)" "$(getval HAS_README inventory.env)" \
    "$(getval HAS_PYPROJECT inventory.env)" "$(getval HAS_TESTS inventory.env)"
  printf '## Agent-authored suite\n\n- ran: %s\n- verdict: %s\n- rc: %s\n\n```\n' \
    "$(getval AGENT_RAN agent-tests.env)" "$(getval AGENT_VERDICT agent-tests.env)" "$agent_rc"
  sed -n '/^AGENT_TAIL<<EOF$/,/^EOF$/p' "$LOGS/agent-tests.env" 2>/dev/null | sed '1d;$d' || true
  printf '```\n\n## Tool mix\n\n```\n'
  grep '^TOOL_' "$LOGS/trace.env" 2>/dev/null || true
  printf '```\n\n## Files\n\n```\n'
  grep '^FILE ' "$LOGS/inventory.env" 2>/dev/null || true
  printf '```\n'
} > "$REPORT"

# ---------------------------------------------------------------- coverage
LEDGER_RC=-1
if [ "${HZ_SPEC_LEDGER:-0}" = "1" ]; then
  ( cd "$TASK_DIR" && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. "$PY" \
      "$ROOT/scripts/spec/spec-ledger.py" --workspace "$TASK_DIR" > "$LOGS/ledger.out" 2>&1 )
  LEDGER_RC=$?
  grep -E '^COVERAGE |^LEDGER=' "$LOGS/ledger.out" >> "$LOGS/ledger.env" 2>/dev/null || true
fi

say ""
say "AGENT_TESTS ran=$(getval AGENT_RAN agent-tests.env) verdict=$(getval AGENT_VERDICT agent-tests.env) rc=$agent_rc"
say "TOOL_CALLS=$(getval TOOL_CALLS trace.env) TOOL_ERRORS=$(getval TOOL_ERRORS trace.env)"
say "FILES=$(getval FILES_TOTAL inventory.env) LOC=$(getval LOC_TOTAL inventory.env)"
say "REPORT $REPORT"
say "TRACE $LOGS/trace.txt"
say "ARENA $TASK_DIR"
if [ "$LEDGER_RC" -ge 0 ]; then
  say "SPEC_LEDGER rc=$LEDGER_RC $(getval COVERAGE ledger.env)"
  printf '\n## Requirement coverage\n\n```\n' >> "$REPORT"
  grep -E '^[A-Z][0-9]+ ' "$LOGS/ledger.out" 2>/dev/null >> "$REPORT" || true
  grep -E '^COVERAGE |^LEDGER=' "$LOGS/ledger.out" 2>/dev/null >> "$REPORT" || true
  printf '```\n' >> "$REPORT"
  if [ "$LEDGER_RC" -ne 0 ]; then
    say "PYTASK=PARTIAL"
    exit 2
  fi
fi
say "PYTASK=DONE"
exit 0
