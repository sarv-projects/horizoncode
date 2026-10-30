#!/usr/bin/env bash
# Run ONE arbitrary prompt against a live HorizonCode session and print the tool trace.
#
#   bash scripts/e2e/probe-prompt.sh "Search the web for RFC 9457 and report the URL."
#   HZ_PROBE_DIR=/path/to/arena bash scripts/e2e/probe-prompt.sh "..."
#
# Purpose: capability evidence, one capability at a time (web browse, code read,
# self-repair, ...). Same isolated stack as scripts/e2e/py-task.sh; the arena is
# whatever HZ_PROBE_DIR points at (default: a fresh scratch directory).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

[ "$#" -ge 1 ] || { printf 'usage: %s "<prompt>"\n' "${BASH_SOURCE[0]}" >&2; exit 1; }
PROMPT_TEXT="$1"

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/probe-$RUN_TAG"
STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
PROJECT="${HZ_PROBE_DIR:-$ROOT/bench/probe/$RUN_TAG}"
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
PROMPT_TIMEOUT="${HZ_PROBE_TIMEOUT:-900}"
SERVER_PID=""

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  [ "${HZ_PROBE_KEEP:-0}" = "1" ] || rm -rf "$RUN" "$STATE_HOME_OVERRIDE"
  exit "$rc"
}
trap 'cleanup $?' EXIT

ORIG_HOME="${HOME:-/nonexistent}"
export PATH="$ORIG_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BUN="$(command -v bun)"
PY="$(command -v python3)"
set -a; . "$ROOT/.env"; set +a
[ -n "${NVIDIA_API_KEY:-}" ] || { echo "NVIDIA_API_KEY missing"; exit 1; }

mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/config" "$RUN/data" "$RUN/cache" "$STATE_HOME_OVERRIDE" "$PROJECT"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$STATE_HOME_OVERRIDE"
export OPENCODE_SERVER_PASSWORD="probe-$RANDOM-$RANDOM"
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
export HZ_E2E_BOOTSTRAP_NEMOTRON=1

# shellcheck source=lib/bootstrap-horizoncode-config.sh
. "$HZ_LIB_DIR/bootstrap-horizoncode-config.sh"
hz_bootstrap_horizoncode_config

SNAP="$(ls -t "$ORIG_HOME"/.cache/opencode/models*.json 2>/dev/null | grep -v 'meta\.json$' | head -n1)"
mkdir -p "$XDG_CACHE_HOME/opencode"
cp -f "$SNAP" "$XDG_CACHE_HOME/opencode/models.json"
python3 - "$XDG_CACHE_HOME/opencode/models.json" "$MODEL_ID" <<'PYLIM'
import json, sys
path, model_id = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
for provider in data.values():
    for mid, model in ((provider or {}).get("models") or {}).items():
        if mid == model_id:
            lim = model.get("limit") or {}
            if int(lim.get("output", 0)) < 32768:
                lim["output"] = 32768
                model["limit"] = lim
json.dump(data, open(path, "w", encoding="utf-8"))
PYLIM

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

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
BASE="http://127.0.0.1:$port"
( cd "$ROOT" && exec env HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 HORIZONCODE_LOCAL_CLI=1 \
    NEMOTRON_PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}" \
    "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" --print-logs serve \
    --hostname 127.0.0.1 --port "$port" ) > "$RUN/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 240); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  curl -fsS --max-time 2 "$BASE/global/health" -H "Authorization: $AUTH" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS --max-time 5 "$BASE/global/health" -H "Authorization: $AUTH" >/dev/null || { echo "server did not start"; tail -20 "$RUN/serve.log"; exit 1; }

curl -sS --max-time 30 -o "$RUN/session.json" -X POST "$BASE/session" \
  -H "Authorization: $AUTH" -H 'content-type: application/json' -d '{"title":"probe"}' >/dev/null
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$RUN/session.json")"
rev="$(curl -sS -i --max-time 20 -H "Authorization: $AUTH" \
  "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null \
  | grep -o '"revision":"[^"]*"' | head -1 | cut -d'"' -f4)"
curl -sS --max-time 20 -o /dev/null -X PATCH "$BASE/config/direct-session-permission-mode?sessionID=$SID" \
  -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$rev\"}"
echo "session=$SID arena=$PROJECT"

python3 - "$PROMPT_TEXT" "$MODEL_ID" > "$RUN/request.json" <<'PYREQ'
import json, os, sys
text, model = sys.argv[1], sys.argv[2]
provider = os.environ.get("NEMOTRON_PROVIDER_ID", "nvidia")
model_id = model
print(json.dumps({"model": {"providerID": provider, "modelID": model_id},
                  "parts": [{"type": "text", "text": text}]}))
PYREQ

T0=$(python3 -c 'import time; print(round(time.time()))')
curl -sS --max-time "$PROMPT_TIMEOUT" -o "$RUN/response.json" -w '' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$RUN/request.json" 2>/dev/null
deadline=$((SECONDS + PROMPT_TIMEOUT))
while :; do
  curl -sS --max-time 15 "$BASE/session/$SID/message?limit=400" -H "Authorization: $AUTH" -o "$RUN/messages.json" 2>/dev/null || true
  state=$(python3 - "$RUN/messages.json" <<'PYSTATE' 2>/dev/null || true
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
  sleep 3
done
T1=$(python3 -c 'import time; print(round(time.time()))')

python3 - "$RUN/messages.json" "$((T1 - T0))" <<'PYTRACE'
import json, sys, collections
data = json.load(open(sys.argv[1], encoding="utf-8"))
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
counts = collections.Counter(); errors = collections.Counter()
final = ""
for message in msgs:
    if not isinstance(message, dict): continue
    info = message.get("info") or {}
    for part in (message.get("parts") or []):
        if part.get("type") == "text" and info.get("role") == "assistant" and part.get("text"):
            final = part["text"]
        if part.get("type") != "tool": continue
        state = part.get("state") or {}
        counts[part.get("tool") or "?"] += 1
        if state.get("status") != "completed":
            errors["%s:%s" % (part.get("tool"), state.get("status"))] += 1
            detail = state.get("error")
            if isinstance(detail, dict): detail = detail.get("message") or json.dumps(detail)
            print("FAILED_CALL %s :: %s" % (part.get("tool"), str(detail)[:160]))
print("PROBE_SECONDS=%s" % sys.argv[2])
print("TOOL_CALLS=%d" % sum(counts.values()))
print("TOOL_ERRORS=%d" % sum(errors.values()))
for name, n in counts.most_common():
    print("TOOL %-22s %d" % (name, n))
print("--- FINAL TEXT (1200 chars) ---")
print(final[-1200:])
PYTRACE
