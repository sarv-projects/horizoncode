#!/usr/bin/env bash
# Probe ONE or a few slash commands through POST /session/:id/command.
#
#   bash scripts/e2e/slash-probe-one.sh issues translate
#
# Same isolated environment as scripts/e2e/py-task.sh (own HOME/XDG/state,
# models.dev catalog patched to a 32768 output limit, kernel wrapper, source-mode
# serve, provider nvidia). Prints the HTTP status and the first 200 characters of
# the response for each command.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

[ "$#" -ge 1 ] || { printf 'usage: %s <command> [command...]\n' "${BASH_SOURCE[0]}" >&2; exit 1; }

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/one-$RUN_TAG"
STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
PROJECT="$ROOT/bench/py/slash-one"
PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
KEY_VAR=NVIDIA_API_KEY

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
  if [ "${HZ_ONE_KEEP:-0}" = "1" ]; then
    printf 'kept: %s\n' "$RUN"
  else
    rm -rf "$RUN" "$STATE_HOME_OVERRIDE" "$PROJECT" 2>/dev/null || true
  fi
  exit "$rc"
}
trap 'cleanup $?' EXIT

ORIG_HOME="${HOME:-/nonexistent}"
export PATH="$ORIG_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BUN="$(command -v bun)"
[ -f "$ROOT/.env" ] || { echo "no .env"; exit 1; }
set -a; . "$ROOT/.env"; set +a
[ -n "${!KEY_VAR:-}" ] || { echo "$KEY_VAR missing"; exit 1; }
export HZ_E2E_BOOTSTRAP_NEMOTRON=1

mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/config" "$RUN/data" "$RUN/cache" "$STATE_HOME_OVERRIDE" "$PROJECT"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$STATE_HOME_OVERRIDE"
export OPENCODE_SERVER_PASSWORD="one-$RANDOM-$RANDOM"
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"

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
    "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" --print-logs serve \
    --hostname 127.0.0.1 --port "$port" ) > "$RUN/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 240); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  if curl -fsS --max-time 2 "$BASE/global/health" -H "Authorization: $AUTH" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS --max-time 5 "$BASE/global/health" -H "Authorization: $AUTH" >/dev/null || {
  echo "server did not start"; tail -20 "$RUN/serve.log"; exit 1; }
echo "server up: $BASE"

curl -sS --max-time 30 -o "$RUN/session.json" -X POST "$BASE/session" \
  -H "Authorization: $AUTH" -H 'content-type: application/json' -d '{"title":"slash-one"}' >/dev/null
SID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$RUN/session.json")"
echo "session: $SID"

rev="$(curl -sS -i --max-time 20 -H "Authorization: $AUTH" \
  "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null \
  | grep -o '"revision":"[^"]*"' | head -1 | cut -d'"' -f4)"
curl -sS --max-time 20 -o /dev/null -X PATCH "$BASE/config/direct-session-permission-mode?sessionID=$SID" \
  -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$rev\"}"

cat > "$RUN/probe_cmd.py" <<'PY'
import json, os, sys, threading, time, urllib.request, urllib.error

BASE = os.environ["PROBE_BASE"].rstrip("/")
AUTH = os.environ["PROBE_AUTH"]
SID = os.environ["PROBE_SID"]
PROVIDER = os.environ["PROBE_PROVIDER"]
MODEL = os.environ["PROBE_MODEL"]
TIMEOUT = float(os.environ.get("PROBE_TIMEOUT", "600"))

def call(method, path, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": AUTH, "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")

def pending(sid):
    st, body = call("GET", "/permission", timeout=20)
    if st != 200:
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    items = data if isinstance(data, list) else (data.get("data") or data.get("permissions") or [])
    return [i for i in items if isinstance(i, dict) and i.get("sessionID") == sid]

def probe(name):
    body = {"command": name, "arguments": "", "model": PROVIDER + "/" + MODEL}
    box = {}
    def worker():
        box["r"] = call("POST", "/session/%s/command" % SID, body, timeout=TIMEOUT)
    th = threading.Thread(target=worker, daemon=True)
    t0 = time.time()
    th.start()
    seen = set()
    while th.is_alive() and time.time() - t0 < TIMEOUT:
        for req in pending(SID):
            rid = req.get("id")
            if not rid or rid in seen:
                continue
            seen.add(rid)
            reply = "reject" if req.get("permission") == "external_directory" else "always"
            call("POST", "/permission/%s/reply" % rid, {"reply": reply}, timeout=20)
        time.sleep(1)
    if th.is_alive():
        call("POST", "/session/%s/abort" % SID, timeout=25)
        th.join(timeout=10)
        return 0, "timeout after %ss" % int(time.time() - t0)
    return box.get("r", (0, "no response"))

name = sys.argv[1]
st, raw = probe(name)
print(json.dumps({"name": name, "http": st, "body": raw[:500]}))
PY

export PROBE_BASE="$BASE" PROBE_AUTH="$AUTH" PROBE_SID="$SID" \
  PROBE_PROVIDER="$PROVIDER_ID" PROBE_MODEL="$MODEL_ID" PROBE_TIMEOUT="${HZ_ONE_TIMEOUT:-900}"

for name in "$@"; do
  line=$(python3 "$RUN/probe_cmd.py" "$name" 2>/dev/null || echo '{"http":0,"body":"probe crashed"}')
  code=$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("http",0))' 2>/dev/null || echo 0)
  body=$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("body","")[:200])' 2>/dev/null || echo "")
  if [[ ! "$code" =~ ^[0-9]+$ ]]; then code="000"; fi
  printf '%-22s http=%s  %s\n' "$name" "$code" "$body"
  if [ "$code" -lt 200 ] 2>/dev/null || [ "$code" -ge 300 ] 2>/dev/null; then
    echo "slash-probe-one: $name failed (http=$code)" >&2
    exit 1
  fi
done
echo "SLASH_ONE=DONE"
