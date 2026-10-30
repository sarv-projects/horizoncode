#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Subagent-lane journey: prove the Task tool actually dispatches a child turn.
#
#   <scratch>/                       <- EMPTY arena = the whole world
#   parent session                   <- must call `task`
#   child session (explorer)         <- must run and answer
#   parent final text                <- must quote the child's answer
#
# Boots the same isolated stack as scripts/e2e/py-task.sh: isolated HOME/XDG,
# models.dev catalog patched to a 32768 output limit, kernel wrapper, source-mode
# `serve`, provider nvidia from the repo `.env`.
#
# Usage:
#   bash scripts/e2e/subagent-task.sh
#   HZ_SUB_KEEP=1 bash scripts/e2e/subagent-task.sh    # keep scratch + logs
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/sub-$RUN_TAG"
LOGS="$E2E/logs/subagent-$RUN_ID"
STATE_HOME_OVERRIDE="/tmp/hz-sub-$RUN_TAG"
ARENA="$ROOT/.tmp/arena-sub-$RUN_TAG"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
SERVE_MODE="${HZ_SERVE_MODE:-source}"
PROMPT_TIMEOUT="${HZ_SUB_TIMEOUT:-900}"

PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
case "$PROVIDER_ID" in
  nvidia) KEY_VAR=NVIDIA_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  *) printf 'SUBTASK=FAIL\nEVIDENCE_FAIL step=env detail=unsupported provider %s\n' "$PROVIDER_ID" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }
fatal() { say "SUBTASK=FAIL"; say "EVIDENCE_FAIL step=$1 detail=$2"; exit 1; }

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
  [ "${HZ_SUB_KEEP:-0}" = "1" ] || rm -rf "$RUN" "$ARENA"
  rm -rf "$STATE_HOME_OVERRIDE" 2>/dev/null || true
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
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
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-sub-$RANDOM-$RANDOM}"
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"

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
# Empty arena: the agent's whole world. No repo, no source, nothing to copy.
# ---------------------------------------------------------------------------
rm -rf "$ARENA"
mkdir -p "$ARENA" || fatal env "could not create arena $ARENA"
say "ARENA $ARENA (empty: $(ls -A "$ARENA" | wc -l) entries)"

# ---------------------------------------------------------------------------
# HostKernel wrapper (source mode)
# ---------------------------------------------------------------------------
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" | cut -d' ' -f1)"
python3 - "$RUN/kernel-wrapper.ts" "$KERNEL_BIN" "$KERNEL_SHA" "$ROOT/packages/horizoncode/src/index.ts" "$ARENA" <<'PYWRAP'
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
  say "SERVER attempt $attempt failed"; tail -c 800 "$LOGS/serve.log" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
done
[ -n "$SERVER_PID" ] || fatal server "serve did not become healthy (see $LOGS/serve.log)"
say "server: pid=$SERVER_PID base=$BASE"

create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d '{"title":"subagent-lane"}' 2>/dev/null || echo 000)
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
# The prompt: force exactly one delegation to the `explorer` profile.
# ---------------------------------------------------------------------------
python3 - "$LOGS/prompt-request.json" "$PROVIDER_ID" "$MODEL_ID" <<'PYPROMPT'
import json, sys
out, provider, model = sys.argv[1:4]
text = (
    "Delegate this to the `explorer` subagent with the Task tool: ask it to list "
    "the files in the current directory and report their names, and to include the "
    "absolute path of the directory it listed. Then tell me exactly what it reported."
)
print(json.dumps({
    "model": {"providerID": provider, "modelID": model},
    "parts": [{"type": "text", "text": text}],
}, indent=2), file=open(out, "w", encoding="utf-8"))
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
# Child session discovery (from the parent's task tool part metadata)
# ---------------------------------------------------------------------------
CHILD=$(python3 - "$LOGS/messages.json" <<'PYCHILD' 2>/dev/null || true
import json,sys
data=json.load(open(sys.argv[1],encoding="utf-8"))
msgs = data if isinstance(data,list) else (data.get("messages") or data.get("data") or [])
found=""
for m in msgs:
    for p in (m.get("parts") or []):
        if isinstance(p,dict) and p.get("type")=="tool" and p.get("tool")=="task":
            st=p.get("state") or {}
            md=st.get("metadata") or {}
            if isinstance(md,dict) and isinstance(md.get("sessionId"),str):
                found=md["sessionId"]
print(found)
PYCHILD
)
say "child=${CHILD:-<none>}"
if [ -n "$CHILD" ]; then
  curl -sS --max-time 30 "$BASE/session/$CHILD/message?limit=400" -H "Authorization: $AUTH" \
    -o "$LOGS/child-messages.json" 2>/dev/null || true
  curl -sS --max-time 30 "$BASE/session/$CHILD" -H "Authorization: $AUTH" \
    -o "$LOGS/child-session.json" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Trace + evidence
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
            detail = re.sub(r"[0-9a-f]{8,}", "<hex>", str(detail or "")).replace("\n", " ")[:160]
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

python3 - "$LOGS/messages.json" "$LOGS/child-messages.json" "$LOGS/summary.env" <<'PYSUM'
import json, sys
parent_src, child_src, out = sys.argv[1:4]
def msgs(path):
    try: data = json.load(open(path, encoding="utf-8"))
    except Exception: return []
    return data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
rows = []
p = msgs(parent_src)
task_parts = []
for m in p:
    for part in (m.get("parts") or []):
        if isinstance(part, dict) and part.get("type") == "tool" and part.get("tool") == "task":
            task_parts.append(part)
c = msgs(child_src)
child_tools = []
child_text = ""
for m in c:
    for part in (m.get("parts") or []):
        if not isinstance(part, dict): continue
        if part.get("type") == "tool":
            st = part.get("state") or {}
            child_tools.append("%s:%s" % (part.get("tool"), st.get("status")))
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            child_text = part["text"]
parent_text = ""
for m in reversed(p):
    for part in reversed((m.get("parts") or [])):
        if isinstance(part, dict) and part.get("type") == "text" and not part.get("synthetic"):
            parent_text = part.get("text") or ""
            break
    if parent_text: break
for tp in task_parts:
    st = tp.get("state") or {}
    md = st.get("metadata") or {}
    rows.append("TASK_CALL status=%s" % st.get("status"))
    rows.append("TASK_CHILD_SESSION=%s" % (md.get("sessionId") if isinstance(md, dict) else "?"))
    rows.append("TASK_AGENT=%s" % (md.get("agent") if isinstance(md, dict) else "?"))
    rows.append("TASK_ATTEMPT=%s" % (md.get("attemptID") if isinstance(md, dict) else "?"))
    rows.append("TASK_OUTPUT=%r" % ((st.get("output") or "")[:1200]))
    if st.get("error"):
        rows.append("TASK_ERROR=%r" % (st.get("error"),))
rows.append("CHILD_MESSAGES=%d" % len(c))
rows.append("CHILD_TOOLS=%s" % (",".join(child_tools) or "<none>"))
rows.append("CHILD_TEXT=%r" % (child_text[:1500],))
rows.append("PARENT_FINAL_TEXT=%r" % (parent_text[:1500],))
open(out, "w", encoding="utf-8").write("\n".join(rows) + "\n")
print("\n".join(rows))
PYSUM

if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
  pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
fi

say "LOGS=$LOGS"
say "SESSION=$SID"
[ -n "$CHILD" ] && say "CHILD=$CHILD"
say "SUBTASK=DONE"
