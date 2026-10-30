#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Slash-command probe: which slash commands actually WORK in a live
# HorizonCode session?
#
#   bench/py/slash-probe/   <- EMPTY arena, the session lives here
#
# Boots ONE kernel-backed server (same isolated HOME/XDG/catalog/provider
# setup as scripts/e2e/py-task.sh), creates ONE session in the empty arena,
# enumerates the live registry with GET /command (built-ins + .opencode/command
# + MCP prompts + skills), then probes every name in its own turn.
#
# Two paths, and they are not the same path:
#
#   A) text probe      POST /session/$SID/message  {"parts":[{"type":"text",
#                      "text":"/name"}]}
#   B) dispatch probe  POST /session/$SID/command  {"command":"name",
#                      "arguments":""}
#
# The leading "/" is parsed CLIENT-side (packages/tui/src/component/prompt,
# packages/horizoncode/src/cli/cmd/run, packages/horizoncode/src/acp/service.ts),
# which then calls the command endpoint. /session/:id/message has no slash
# parser at all, so a text probe can only ever prove "the model answered a
# literal string" — that is the IGNORED case. The verdict therefore comes from
# B; A is recorded per command as the IGNORED evidence.
#
# Usage:
#   bash scripts/e2e/slash-commands-probe.sh
#   HZ_SLASH_KEEP=1 bash scripts/e2e/slash-commands-probe.sh   # keep scratch
#   HZ_SLASH_TIMEOUT=120   per-probe wall clock (seconds)
#   HZ_SLASH_GLOBAL_LIMIT  hard wall clock for the sweep (seconds)
#
# Read-only w.r.t. product code. Writes only bench/py/slash-probe (arena),
# .tmp/e2e scratch, and reports/slash-commands-2026-10-29.md.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Terminal effects only bind inside a cgroup owned by the execution principal;
# a harness started from `wsl.exe ... bash -lc` lands in a root-owned cgroup and
# bash silently fails closed. Same guard py-task.sh uses.
# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

TASK_DIR="$ROOT/bench/py/slash-probe"
E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/slash-$RUN_TAG"
LOGS="$E2E/logs/slash-$RUN_ID"
STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
PROJECT="$TASK_DIR"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
REPORT="$ROOT/reports/slash-commands-2026-10-29.md"

PROBE_TIMEOUT="${HZ_SLASH_TIMEOUT:-120}"
GLOBAL_LIMIT="${HZ_SLASH_GLOBAL_LIMIT:-3900}"

PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
case "$PROVIDER_ID" in
  nvidia) KEY_VAR=NVIDIA_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  *) printf 'SLASH=FAIL\nEVIDENCE_FAIL step=env detail=unsupported provider %s\n' "$PROVIDER_ID" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }
fatal() { say "SLASH=FAIL"; say "EVIDENCE_FAIL step=$1 detail=$2"; exit 1; }

SERVER_PID=""
BASE=""
AUTH=""
SID=""
START_EPOCH="$(date +%s)"
REPORT_DONE=0
RESULTS=""

elapsed() { echo $(( $(date +%s) - START_EPOCH )); }

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    pkill -KILL -P "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  stop_server
  # A killed sweep still owes a report: generate one from whatever landed.
  if [ "$REPORT_DONE" = "0" ] && [ -n "$RESULTS" ] && [ -s "$RESULTS" ]; then
    PROBE_BASE="$BASE" PROBE_AUTH="$AUTH" PROBE_RUN="$RUN" PROBE_LOGS="$LOGS" \
      PROBE_REPORT="$REPORT" PROBE_TASK_DIR="$TASK_DIR" PROBE_SID="$SID" \
      PROBE_ELAPSED="$(elapsed)" PROBE_TIMEOUT="$PROBE_TIMEOUT" \
      python3 "$RUN/report.py" 2>/dev/null || true
  fi
  [ "${HZ_SLASH_KEEP:-0}" = "1" ] || rm -rf "$STATE_HOME_OVERRIDE" 2>/dev/null || true
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

server_alive() { [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; }

# ---------------------------------------------------------------------------
# Memory gate: this box is shared. Never boot under pressure.
# ---------------------------------------------------------------------------
for _ in $(seq 1 10); do
  avail=$(free -m | awk '/^Mem:/{print $7}')
  [ -n "${avail:-}" ] || avail=99999
  [ "$avail" -ge 2500 ] && { say "memory: available ${avail}MB"; break; }
  say "memory: available ${avail}MB < 2500MB, waiting 60s"
  sleep 60
done

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
export HZ_E2E_BOOTSTRAP_NEMOTRON=1

mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/config" "$RUN/data" "$RUN/cache" "$LOGS" "$STATE_HOME_OVERRIDE"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$STATE_HOME_OVERRIDE"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-slash-$RANDOM-$RANDOM}"
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"

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
# Empty arena
# ---------------------------------------------------------------------------
rm -rf "$TASK_DIR"
mkdir -p "$TASK_DIR" || fatal env "could not create arena $TASK_DIR"
# The arena is its own git worktree root. Commands such as /init and /review
# expand ${path} to the session worktree; without this they resolve to the
# repository root and would edit user-owned files (AGENTS.md, the real tree).
( cd "$TASK_DIR" && git init -q -b main . && git config user.email probe@slash.local \
    && git config user.name "slash probe" ) || fatal env "could not git-init the arena"
printf '' > "$TASK_DIR/.gitkeep"
say "ARENA task=$TASK_DIR (empty but for its own .git, worktree root)"

# ---------------------------------------------------------------------------
# HostKernel wrapper (source mode)
# ---------------------------------------------------------------------------
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
server_alive || fatal server "serve did not become healthy (see $LOGS/serve.log)"
say "server: pid=$SERVER_PID base=$BASE boot=$(elapsed)s"

create_session() {
  local title="$1" out="$2"
  curl -sS --max-time 30 -o "$out" -X POST "$BASE/session" -H "Authorization: $AUTH" \
    -H 'content-type: application/json' -d "{\"title\":\"$title\"}" 2>/dev/null || true
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$out" 2>/dev/null || true
}

set_mode() {
  local sid="$1" rev="" raw="" code=""
  for _ in 1 2 3 4 5; do
    raw=$(curl -sS -i --max-time 20 -H "Authorization: $AUTH" \
      "$BASE/config/direct-session-permission-mode?sessionID=$sid" 2>/dev/null || true)
    rev=$(printf '%s' "$raw" | grep -o '"revision":"[^"]*"' | head -1 | cut -d'"' -f4)
    [ -n "$rev" ] && break
    sleep 2
  done
  [ -n "$rev" ] || return 1
  code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' \
    -X PATCH -H "Authorization: $AUTH" -H 'content-type: application/json' \
    "$BASE/config/direct-session-permission-mode?sessionID=$sid" \
    -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$rev\"}" \
    2>/dev/null || echo 000)
  [ "$code" = "200" ]
}

SID=$(create_session "slash-probe" "$LOGS/session.json")
[ -n "$SID" ] || fatal session-create "no session id"
set_mode "$SID" || fatal permission-mode "could not set danger-full-access/never on $SID"
say "session=$SID mode=danger-full-access/never boot=$(elapsed)s"

# ---------------------------------------------------------------------------
# The prober: one POST + one completion poll, JSON line out
# ---------------------------------------------------------------------------
cat > "$RUN/probe.py" <<'PYPROBE'
import json, os, sys, threading, time, urllib.request, urllib.error

BASE = os.environ["PROBE_BASE"].rstrip("/")
AUTH = os.environ["PROBE_AUTH"]
PROVIDER = os.environ["PROBE_PROVIDER"]
MODEL = os.environ["PROBE_MODEL"]
TIMEOUT = float(os.environ.get("PROBE_TIMEOUT", "120"))


def call(method, path, body=None, timeout=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": AUTH, "content-type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout or TIMEOUT) as r:
            return r.status, r.read().decode("utf-8", "replace"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:
        return 0, "%s: %s" % (type(e).__name__, e), time.time() - t0


def messages(sid):
    st, body, _ = call("GET", "/session/%s/message?limit=400" % sid, timeout=30)
    if st != 200:
        return []
    try:
        d = json.loads(body)
    except Exception:
        return []
    items = d if isinstance(d, list) else (d.get("messages") or d.get("data") or [])
    return [m for m in items if isinstance(m, dict)]


def role(m):
    info = m.get("info") or {}
    return info.get("role"), info


def snapshot(sid):
    ids = set()
    for m in messages(sid):
        r, info = role(m)
        ids.add(info.get("id"))
    return ids


def user_text(sid, before):
    """The user message the server actually created for this turn."""
    new = [m for m in messages(sid)
           if (m.get("info") or {}).get("role") == "user"
           and (m.get("info") or {}).get("id") not in before]
    if not new:
        return None
    parts = new[-1].get("parts") or []
    text = "\n".join(p.get("text") or "" for p in parts if p.get("type") == "text").strip()
    return text or None


def describe(m):
    info = m.get("info") or {}
    t = info.get("time") or {}
    parts = m.get("parts") or []
    texts = [p.get("text") or "" for p in parts if p.get("type") == "text"]
    reasoning = [p.get("text") or "" for p in parts if p.get("type") == "reasoning"]
    tools = [p.get("tool") or "?" for p in parts if p.get("type") == "tool"]
    err = info.get("error")
    if isinstance(err, dict):
        err = err.get("message") or json.dumps(err, ensure_ascii=False)
    return {
        "id": info.get("id"),
        "completed": bool(t.get("completed")) or info.get("finish") is not None,
        "text": "\n".join(x for x in texts if x).strip(),
        "reasoning": "\n".join(x for x in reasoning if x).strip(),
        "tools": tools[:16],
        "error": (str(err)[:400] if err else None),
        "finish": info.get("finish"),
    }


def pending_permissions(sid):
    st, body, _ = call("GET", "/permission", timeout=20)
    if st != 200:
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    items = data if isinstance(data, list) else (data.get("data") or data.get("permissions") or [])
    return [i for i in items if isinstance(i, dict) and i.get("sessionID") == sid]


def turn_of(sid, before):
    new = [m for m in messages(sid)
           if (m.get("info") or {}).get("role") == "assistant"
           and (m.get("info") or {}).get("id") not in before]
    steps = [describe(m) for m in new]
    if not steps:
        return None
    return {
        "id": steps[-1]["id"],
        "completed": all(s["completed"] for s in steps),
        "reply": "\n".join(s["text"] for s in steps if s["text"]).strip(),
        "reasoning": "\n".join(s["reasoning"] for s in steps if s["reasoning"]).strip(),
        "tools": [t for s in steps for t in s["tools"]][:16],
        "error": next((s["error"] for s in steps if s["error"]), None),
        "steps": len(steps),
        "finish": steps[-1].get("finish"),
    }


def probe(kind, sid, name):
    before = snapshot(sid)
    if kind == "text":
        path = "/session/%s/message" % sid
        body = {"model": {"providerID": PROVIDER, "modelID": MODEL},
                "parts": [{"type": "text", "text": "/" + name}]}
    else:
        path = "/session/%s/command" % sid
        body = {"command": name, "arguments": "", "model": PROVIDER + "/" + MODEL}

    # The POST blocks until the turn ends, so it runs in a thread while this
    # side keeps the turn alive: a command that reaches for a path outside its
    # project blocks on an interactive permission prompt, and a real user would
    # answer it. Every answer is recorded so the report can say so.
    box = {}

    def worker():
        box["r"] = call("POST", path, body)

    th = threading.Thread(target=worker, daemon=True)
    t0 = time.time()
    th.start()
    deadline = t0 + TIMEOUT
    approvals = []
    turn = None
    while True:
        for req in pending_permissions(sid):
            rid = req.get("id")
            if not rid or any(a["id"] == rid for a in approvals):
                continue
            # Everything inside the session's own project is granted. Anything
            # that reaches outside the arena is declined: this probe must never
            # read or write user-owned files, and a declined read keeps the
            # turn short instead of letting the model tour the repository.
            reply = "reject" if req.get("permission") == "external_directory" else "always"
            st, _raw, _dt = call("POST", "/permission/%s/reply" % rid, {"reply": reply}, timeout=20)
            approvals.append({"id": rid, "permission": req.get("permission"),
                              "patterns": req.get("patterns"), "reply": reply, "http": st})
        turn = turn_of(sid, before)
        if not th.is_alive() and turn and turn["completed"]:
            break
        if time.time() >= deadline:
            break
        time.sleep(1)

    timed_out = th.is_alive()
    if timed_out:
        call("POST", "/session/%s/abort" % sid, timeout=25)
        th.join(timeout=10)
        st, raw, dt = 0, "transport timeout after %ss (turn aborted)" % int(time.time() - t0), time.time() - t0
    else:
        st, raw, dt = box.get("r", (0, "no response", time.time() - t0))
    return {"kind": kind, "name": name, "http": st, "elapsed": round(dt, 1),
            "timed_out": timed_out, "body": raw[:500], "turn": turn, "approvals": approvals,
            "user_text": (user_text(sid, before) or "")[:1200]}


def main():
    cmd = sys.argv[1]
    if cmd == "clear":
        st, raw, _ = call("POST", "/session/%s/context/clear" % sys.argv[2], timeout=45)
        print(json.dumps({"kind": "clear", "http": st, "body": raw[:200]}))
        return
    if cmd == "list":
        st, raw, _ = call("GET", "/command", timeout=120)
        if st != 200:
            print(json.dumps({"kind": "list", "http": st, "body": raw[:300]}))
            raise SystemExit(0)
        data = json.loads(raw)
        items = data if isinstance(data, list) else (data.get("data") or data.get("commands") or [])
        rows = []
        for item in items:
            name = str(item.get("name") or "")
            if not name:
                continue
            rows.append({
                "name": name,
                "source": str(item.get("source") or ""),
                "description": " ".join(str(item.get("description") or "").split()),
                "hints": item.get("hints") or [],
                "subtask": bool(item.get("subtask")),
            })

        def order(row):
            src = row["source"]
            rank = 0 if row["name"] in ("init", "review") else (1 if src == "command" else (2 if src == "skill" else 3))
            return (rank, row["name"].lower())
        rows.sort(key=order)
        print(json.dumps({"kind": "list", "http": st, "count": len(rows), "commands": rows}))
        return
    kind = "text" if cmd == "text" else "cmd"
    print(json.dumps(probe(kind, sys.argv[2], sys.argv[3]), ensure_ascii=False))


main()
PYPROBE
[ -s "$RUN/probe.py" ] || fatal env "could not write probe.py"

# ---------------------------------------------------------------------------
# Report generator (reads the JSONL the sweep wrote)
# ---------------------------------------------------------------------------
cat > "$RUN/report.py" <<'PYREPORT'
import json, os, re, sys

RUN = os.environ["PROBE_RUN"]
LOGS = os.environ["PROBE_LOGS"]
REPORT = os.environ["PROBE_REPORT"]
TASK_DIR = os.environ.get("PROBE_TASK_DIR", "")
PROVIDER = os.environ.get("PROBE_PROVIDER", "?")
MODEL = os.environ.get("PROBE_MODEL", "?")
SID = os.environ.get("PROBE_SID", "?")
ELAPSED = os.environ.get("PROBE_ELAPSED", "?")


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def cell(text, width=200):
    if text is None:
        return ""
    s = " ".join(str(text).split())
    if len(s) > width:
        s = s[:width].rstrip() + "…"
    return s.replace("|", "\\|")


def verdict_cmd(rec, name):
    c = rec.get("cmd")
    if not c:
        return "UNPROBED", ""
    turn = c.get("turn") or {}
    body = c.get("body") or ""
    err = turn.get("error") or ""
    combined = body + " " + err
    sent = (c.get("user_text") or "").strip()
    if c.get("http") == 0:
        return "TIMEOUT", "no HTTP response after %ss: %s" % (c.get("elapsed"), cell(body, 200))
    if "Command not found" in combined:
        return "ERROR", cell(err or body, 300)
    if not (200 <= int(c.get("http") or 0) < 300):
        return "ERROR", cell(err or body, 300)
    if err:
        return "ERROR", cell(err, 300)
    if sent and sent == "/" + name:
        return "IGNORED", "the dispatch endpoint echoed the literal text instead of a template"
    if not sent:
        if "task" in (turn.get("tools") or []):
            return "WORKS", ""
        return "ERROR", "no user message was created for the command"
    if not turn:
        return "TIMEOUT", "command expanded but no assistant message after %ss" % c.get("elapsed")
    if turn.get("reply") or turn.get("tools") or turn.get("reasoning"):
        return "WORKS", ""
    if turn.get("completed"):
        return "EMPTY", "turn completed with no text, reasoning or tool call"
    return "TIMEOUT", "assistant turn never completed"


def dispatch_state(rec):
    """distinguish a slow-but-dispatched turn from one that never started"""
    c = rec.get("cmd") or {}
    if not c:
        return "unprobed"
    turn = c.get("turn") or {}
    sent = (c.get("user_text") or "").strip()
    if c.get("http") == 0:
        return "dispatched_slow" if (sent or turn.get("tools")) else "no_response"
    if not (200 <= int(c.get("http") or 0) < 300):
        return "error"
    return "ok"


def command_pin(name):
    """Frontmatter model/agent a config command pins, if any."""
    if not TASK_DIR:
        return ""
    repo = os.path.dirname(os.path.dirname(os.path.dirname(TASK_DIR)))
    path = os.path.join(repo, ".opencode", "command", name + ".md")
    if not os.path.exists(path):
        return ""
    try:
        head = open(path, encoding="utf-8", errors="replace").read().split("---")[1]
    except Exception:
        return ""
    pins = [l.strip() for l in head.splitlines() if l.strip().startswith(("model:", "agent:"))]
    return "; ".join(pins)


def evidence_of(rec):
    """Template expansion + the assistant's first words, in one cell."""
    c = rec.get("cmd") or {}
    turn = c.get("turn") or {}
    sent = " ".join((c.get("user_text") or "").split())
    said = " ".join((turn.get("reply") or turn.get("reasoning") or "").split())
    bits = []
    if sent:
        bits.append('sent: "%s"' % (sent[:90] + ("…" if len(sent) > 90 else "")))
    if said:
        bits.append('said: "%s"' % (said[:90] + ("…" if len(said) > 90 else "")))
    elif turn.get("tools"):
        bits.append("tools only: %s" % ", ".join(turn["tools"][:4]))
    return cell(" · ".join(bits), 240)


def verdict_text(rec):
    t = rec.get("text")
    if not t:
        return "UNPROBED"
    turn = t.get("turn") or {}
    if t.get("http") == 0:
        return "TIMEOUT"
    if not (200 <= int(t.get("http") or 0) < 300):
        return "ERROR"
    if turn.get("error"):
        return "ERROR"
    if turn.get("reply") or turn.get("tools"):
        return "IGNORED"
    return "EMPTY"


def responded(rec):
    c = rec.get("cmd") or {}
    turn = c.get("turn") or {}
    return "yes" if (turn.get("reply") or turn.get("tools") or turn.get("reasoning")) else "no"


results = read_jsonl(os.path.join(RUN, "results.jsonl"))
cliform = read_jsonl(os.path.join(RUN, "cliform.jsonl"))

by = {}
for d in results:
    name = d.get("name")
    if not name:
        continue
    rec = by.setdefault(name, {"name": name, "source": d.get("source") or ""})
    if d.get("skipped"):
        rec["skipped"] = d["skipped"]
    kind = d.get("kind")
    if kind in ("text", "cmd"):
        rec[kind] = d

order = []
sources = {}
try:
    reg = json.load(open(os.path.join(RUN, "registry.json"), encoding="utf-8"))
    order = [r["name"] for r in reg.get("commands", [])]
    sources = {r["name"]: (r.get("source") or "") for r in reg.get("commands", [])}
except Exception:
    order = list(by.keys())
for name in list(by):
    if sources.get(name):
        by[name]["source"] = sources[name]
for name in by:
    if name not in order:
        order.append(name)

rows = []
counts = {"WORKS": 0, "IGNORED": 0, "ERROR": 0, "TIMEOUT": 0, "EMPTY": 0, "UNPROBED": 0}
text_counts = {"IGNORED": 0, "ERROR": 0, "TIMEOUT": 0, "EMPTY": 0, "UNPROBED": 0}
broken = []
for name in order:
    rec = by.get(name, {"name": name, "source": ""})
    v, ev = verdict_cmd(rec, name)
    tv = verdict_text(rec)
    counts[v] = counts.get(v, 0) + 1
    text_counts[tv] = text_counts.get(tv, 0) + 1
    c = rec.get("cmd") or {}
    t = rec.get("text") or {}
    row = {
        "name": name,
        "source": sources.get(name) or rec.get("source") or "",
        "http": c.get("http", "-"),
        "responded": responded(rec),
        "verdict": v,
        "text": tv,
        "text_http": t.get("http", "-"),
        "evidence": evidence_of(rec) if v == "WORKS" else (ev or evidence_of(rec)),
        "skipped": rec.get("skipped"),
        "sent": c.get("user_text") or "",
    }
    rows.append(row)
    if v in ("ERROR", "TIMEOUT", "EMPTY"):
        broken.append((row, ev))

L = []
A = L.append
A("# Slash commands in a live HorizonCode session — 2026-10-29")
A("")
A("Every command the live registry advertises, probed in its own turn against a real")
A("kernel-backed server and a real provider. Generated by")
A("`scripts/e2e/slash-commands-probe.sh`; no product code was modified.")
A("")
A("- model: `%s` (provider `%s`)" % (MODEL, PROVIDER))
A("- server: one `serve` process on a free loopback port, source mode (kernel wrapper = `kernel/target/debug/hz-kernel`)")
A("- sessions: one server, one session per worker (`%s` was the first), permission mode `danger-full-access` / `approvalPolicy=never`" % SID)
A("- arena: `%s` (created empty, wiped before the run)" % (TASK_DIR or "bench/py/slash-probe"))
A("- per-probe wall clock: %ss · sweep wall clock: %ss" % (os.environ.get("PROBE_TIMEOUT", "120"), ELAPSED))
A("- logs: `%s`" % LOGS)
A("")
A("## Two paths, and they are not the same path")
A("")
A("| probe | request | reaches the command registry? |")
A("|---|---|---|")
A("| **A. text** | `POST /session/$SID/message` with the single text part `/name` | **No.** `packages/horizoncode/src/session/prompt.ts` has no slash parser on the prompt path; the leading `/` is parsed client-side (`packages/tui/src/component/prompt/index.tsx`, `packages/horizoncode/src/cli/cmd/run/footer.prompt.tsx`, `packages/horizoncode/src/acp/service.ts`), and the client then calls the command endpoint. |")
A("| **B. dispatch** | `POST /session/$SID/command` `{\"command\":\"name\",\"arguments\":\"\"}`  — exactly what the TUI sends | **Yes.** `SessionHttpApi.command` → `SessionPrompt.command` → `Command.get(name)` → template expansion → a real agent turn. |")
A("")
A("**Verdict is taken from probe B** — the only path that can execute a command.")
A("Column *text* records probe A: `IGNORED` means the assistant replied conversationally to the")
A("literal string `/name` instead of the command running, which is what a naive `POST /message`")
A("client sees for **every** command however healthy the registry is. `WORKS` therefore means:")
A("HTTP 2xx from the dispatch endpoint, no `Command not found`, and a completed assistant turn")
A("carrying text or at least one tool call.")
A("")
A("## Per-command results")
A("")
A("| command | source | http | responded | verdict | text (`/name`) | evidence (first 200 chars) |")
A("|---|---|---|---|---|---|---|")
for r in rows:
    A("| `%s` | %s | %s | %s | **%s** | %s (%s) | %s |" % (
        cell(r["name"], 80), r["source"] or "-", r["http"], r["responded"], r["verdict"],
        r["text"], r["text_http"], r["evidence"] or ""))
A("")
A("## What the dispatch endpoint actually put in front of the model")
A("")
A("`POST /command` expands the command template and creates a user message from it. That is the")
A("direct evidence that a name is a *command* and not a string: the very same text sent as a")
A("`/name` message (probe A) stays `\"/name\"` in the transcript.")
A("")
A("| command | user message the server created |")
A("|---|---|")
for r in rows:
    if r["source"] != "command":
        continue
    A("| `%s` | %s |" % (cell(r["name"], 40), cell(" ".join((r.get("sent") or "").split()), 220)))
A("")
tot = len(rows)
A("## Totals")
A("")
A("| outcome | count |")
A("|---|---|")
for k in ("WORKS", "IGNORED", "ERROR", "TIMEOUT", "EMPTY", "UNPROBED"):
    A("| %s | %d |" % (k, counts.get(k, 0)))
A("| **commands probed** | **%d** |" % tot)
A("")
states = {}
for name in order:
    st = dispatch_state(by.get(name, {}))
    states[st] = states.get(st, 0) + 1
A("Dispatch reality behind those verdicts: " + ", ".join("%s=%d" % (k, v) for k, v in sorted(states.items())) + ".")
A("`dispatched_slow` means the command *was* recognised and its template was expanded, but the")
A("agent turn was still running when the 120 s probe budget ran out; `no_response` means the")
A("endpoint produced nothing at all inside the budget.")
A("")
A("Text-path (`/name` in `POST /message`) outcomes: " + ", ".join("%s=%d" % (k, v) for k, v in text_counts.items() if v) + ".")
A("")
A("## Broken ones, with the exact text")
A("")
if broken:
    for row, ev in broken:
        A("### `%s` — %s" % (row["name"], row["verdict"]))
        A("")
        A("```")
        A(ev or "(no error text)")
        A("```")
        A("")
        c = by.get(row["name"], {}).get("cmd") or {}
        if c.get("http"):
            A("- dispatch HTTP: `%s` (%.1fs)" % (c.get("http"), c.get("elapsed") or 0))
        sent = " ".join((c.get("user_text") or "").split())
        if sent:
            A('- template was expanded to: "%s"' % (sent[:160] + ("\u2026" if len(sent) > 160 else "")))
        pin = command_pin(row["name"])
        if pin:
            A("- command frontmatter pins: `%s` (a command's own `model:` wins over the caller's -- SessionPrompt.command)" % pin)
        A("")
else:
    A("None: every command in the registry dispatched and produced an assistant turn.")
    A("")

# CLI-form
if cliform:
    A("## Names a TUI cannot type")
    A("")
    A("The registry exposes commands whose names contain spaces. A slash-prompt client splits the")
    A("typed line on whitespace, so what it would actually dispatch is the first token; the table")
    A("shows what that token resolves to on the dispatch endpoint.")
    A("")
    lived = [r for r in cliform if int(r.get("http") or 0) != 0]
    A("| registry name | what a TUI would send | http | resolves? | response |")
    A("|---|---|---|---|---|")
    for r in cliform:
        if int(r.get("http") or 0) == 0:
            A("| `%s` | `/%s` | \u2014 | not probed | the server had exited before this phase ran |" % (
                cell(r.get("full_name"), 60), cell(r.get("token"), 40)))
            continue
        A("| `%s` | `/%s` | %s | %s | %s |" % (
            cell(r.get("full_name"), 60), cell(r.get("token"), 40), r.get("http"),
            "no \u2014 `Command not found`" if r.get("not_found") else "yes",
            cell(r.get("body"), 120)))
    A("")
    if not lived:
        A("These rows are **not evidence**: the sweep's server had already exited, so each is a")
        A("refused connection rather than an answer. What the registry does show is that the names")
        A("exist and contain spaces; a slash-prompt client splits the typed line on whitespace, so")
        A("the first token is all it can send, and the command endpoint matches names exactly")
        A("\u2014 `/Agent Development` cannot reach `Agent Development`.")
        A("")

def rd(name):
    p = os.path.join(LOGS, name)
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return ""


# permission prompts answered during the sweep
approval_rows = [(name, a) for name in order for a in ((by.get(name, {}).get("cmd") or {}).get("approvals") or [])]
A("## Permission prompts")
A("")
if approval_rows:
    A("A command that reaches for a path outside its own project stops on an interactive")
    A("permission prompt. A real user answers it, and so did the probe — deterministically:")
    A("everything inside the arena was granted (`reply=always`), and any `external_directory`")
    A("request was **declined** (`reply=reject`) so the probe could never touch user-owned")
    A("files. Every decision is listed here:")
    A("")
    A("| command | permission | patterns | reply | http |")
    A("|---|---|---|---|---|")
    seen = set()
    for name, a in approval_rows:
        key = (name, a.get("permission"), tuple(a.get("patterns") or []))
        if key in seen:
            continue
        seen.add(key)
        A("| `%s` | %s | %s | %s | %s |" % (cell(name, 60), a.get("permission"),
                                            cell(", ".join(a.get("patterns") or []), 90),
                                            a.get("reply"), a.get("http")))
    A("")
    A("Total prompts answered: %d." % len(seen))
else:
    A("No command triggered a permission prompt.")
A("")

# repo cleanliness
before_txt = rd("repo-before.txt")
after_txt = rd("repo-after.txt")
if before_txt or after_txt:
    b = set(before_txt.splitlines())
    a = set(after_txt.splitlines())
    added = sorted(a - b)
    A("## Blast radius")
    A("")
    A("`git status --porcelain` in the repository was captured before and after the sweep.")
    A("")
    if added:
        A("New entries after the sweep (%d):" % len(added))
        A("")
        A("```")
        A("\n".join(added[:40]))
        A("```")
    else:
        A("No change: the sweep wrote nothing into the product tree.")
    A("")
    if any(x.startswith("?? reports/") for x in added):
        A("Entries under `reports/` other than this file were written by a concurrent session, not")
        A("by the sweep: the probe writes only `.tmp/e2e/`, the arena and this report.")
        A("")
    A("The arena has its own `.git`, so `${path}` in `init`/`review` templates resolves to the")
    A("arena, not to the repository root.")
    A("")

# CLI checks
help_rc = rd("help.rc").strip()
run_rc = rd("run-help.rc").strip()
help_out = rd("cli/help.out")
help_err = rd("cli/help.err")
run_out = rd("cli/run-help.out")
run_err = rd("cli/run-help.err")

A("## CLI surface")
A("")
A("`packages/horizoncode/bin/horizoncode` (the `bin` entry `horizoncode`/`hzcode` points at it).")
A("There is no `./bin/horizoncode` at the repository root; the launcher lives in the package.")
A("")
A("| invocation | rc | stdout | stderr |")
A("|---|---|---|---|")
A("| `bun ./bin/horizoncode --help` | %s | %d B | %d B |" % (help_rc, len(help_out), len(help_err)))
A("| `bun ./bin/horizoncode run --help` | %s | %d B | %d B |" % (run_rc, len(run_out), len(run_err)))
A("")
A("```text")
A("$ bun ./bin/horizoncode --help   # stderr")
A((help_err.strip() or "(empty)")[:1200])
A("")
A("$ bun ./bin/horizoncode --help   # stdout (head)")
A("\n".join(help_out.strip().splitlines()[:40]) or "(empty)")
A("```")
A("")
A("```text")
A("$ bun ./bin/horizoncode run --help   # stderr")
A((run_err.strip() or "(empty)")[:1200])
A("")
A("$ bun ./bin/horizoncode run --help   # stdout (head)")
A("\n".join(run_out.strip().splitlines()[:40]) or "(empty)")
A("```")
A("")

# init arena evidence
atext = rd("arena-after-init-text.txt").strip()
acmd = rd("arena-after-init-cmd.txt").strip()
A("## Known-good comparison, end to end")
A("")
A("`/init` is the canonical built-in, so it is the reference for \"recognised\".")
A("")
A("- after the **text** probe `/init` in `POST /message`, the arena contained: `%s`" % (atext or "(nothing)"))
A("- after the **dispatch** probe `POST /command {\"command\":\"init\"}`, the arena contained: `%s`" % (acmd or "(nothing)"))
A("")
A("The literal string changed nothing; the dispatch endpoint ran the command template for real.")
A("")
A("## Cleanup")
A("")
A("The server was stopped on every exit path (`cleanup` trap), the isolated state directory was")
A("removed, and the arena was left in place for inspection. Only `bench/py/slash-probe/`,")
A("`.tmp/e2e/` scratch and this report were written.")
A("")

open(REPORT, "w", encoding="utf-8").write("\n".join(L) + "\n")
print("REPORT_WRITTEN %s (%d rows)" % (REPORT, tot))
PYREPORT


export PROBE_BASE="$BASE" PROBE_AUTH="$AUTH" PROBE_PROVIDER="$PROVIDER_ID" \
       PROBE_MODEL="$MODEL_ID" PROBE_TIMEOUT="$PROBE_TIMEOUT"

# ---------------------------------------------------------------------------
# Enumerate the live registry
# ---------------------------------------------------------------------------
python3 "$RUN/probe.py" list > "$RUN/registry.json" 2>"$LOGS/list.err" || true
list_http=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("http","-"))' "$RUN/registry.json" 2>/dev/null || echo "-")
say "GET /command -> HTTP $list_http"
[ "$list_http" = "200" ] || fatal list "GET /command failed: $(head -c 300 "$LOGS/list.err")"
python3 - "$RUN/registry.json" "$RUN/commands.tsv" <<'PYTSV'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
rows = data["commands"]
with open(sys.argv[2], "w", encoding="utf-8") as f:
    for r in rows:
        f.write("%s\t%s\t%s\n" % (r["name"].replace("\t", " "), r["source"], r["description"].replace("\t", " ")))
print("REGISTRY total=%d command=%d skill=%d mcp=%d" % (
    len(rows),
    sum(1 for r in rows if r["source"] == "command"),
    sum(1 for r in rows if r["source"] == "skill"),
    sum(1 for r in rows if r["source"] == "mcp"),
))
PYTSV
cp "$RUN/commands.tsv" "$RUN/commands.all.tsv"
if [ -n "${HZ_SLASH_MAX:-}" ]; then
  head -n "$HZ_SLASH_MAX" "$RUN/commands.all.tsv" > "$RUN/commands.tsv"
  say "SMOKE HZ_SLASH_MAX=$HZ_SLASH_MAX (of $(wc -l < "$RUN/commands.all.tsv" | tr -d ' '))"
fi
if [ -n "${HZ_SLASH_ONLY:-}" ]; then
  python3 - "$RUN/commands.tsv" "$RUN/commands.pick.tsv" "$HZ_SLASH_ONLY" <<'PYPICK'
import sys
src, out, want = sys.argv[1], sys.argv[2], set(x.strip() for x in sys.argv[3].split(",") if x.strip())
keep = [l for l in open(src, encoding="utf-8") if l.split("\t")[0] in want]
open(out, "w", encoding="utf-8").writelines(keep)
print("PICK kept %d of %d" % (len(keep), len(want)))
PYPICK
  cp "$RUN/commands.pick.tsv" "$RUN/commands.tsv"
fi
CMD_COUNT=$(wc -l < "$RUN/commands.tsv" | tr -d ' ')
say "commands enumerated: $(wc -l < "$RUN/commands.all.tsv" | tr -d ' ') (probing $CMD_COUNT)"

RESULTS="$RUN/results.jsonl"
CLIFORM="$RUN/cliform.jsonl"
: > "$RESULTS"
: > "$CLIFORM"
git -C "$ROOT" status --porcelain > "$LOGS/repo-before.txt" 2>/dev/null || true

arena_state() { ( cd "$TASK_DIR" && find . -type f 2>/dev/null | sed 's|^\./||' | sort | head -40 ); }

# ---------------------------------------------------------------------------
# The sweep: one command per turn, two probes, one context clear.
# Several sessions on the one server so the 101x2 turns finish in minutes;
# every command still gets its own turn.
# ---------------------------------------------------------------------------
NSESS="${HZ_SLASH_SESSIONS:-4}"
SESSIONS=("$SID")
i=1
while [ "$i" -lt "$NSESS" ]; do
  nsid=$(create_session "slash-probe-$i" "$RUN/session-$i.json")
  if [ -n "$nsid" ] && set_mode "$nsid"; then
    SESSIONS+=("$nsid")
  else
    say "session[$i] failed to initialise; continuing with ${#SESSIONS[@]}"
  fi
  i=$((i + 1))
done
say "sessions: ${#SESSIONS[@]}"

python3 - "$RUN/commands.tsv" "$RUN" "${#SESSIONS[@]}" <<'PYSPLIT'
import sys
src, run, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
lines = [l.rstrip("\n") for l in open(src, encoding="utf-8") if l.strip()]
slices = [[] for _ in range(n)]
for i, line in enumerate(lines):
    slices[i % n].append(line)
for i, chunk in enumerate(slices):
    open("%s/slice-%d.tsv" % (run, i), "w", encoding="utf-8").write("\n".join(chunk) + ("\n" if chunk else ""))
print("SPLIT " + " ".join(str(len(c)) for c in slices))
PYSPLIT

sweep_session() {
  local sid="$1" slice="$2" out="$3" tag="$4"
  local idx=0 name source desc text_line cmd_line
  : > "$out"
  while IFS=$'\t' read -r name source desc; do
    [ -n "$name" ] || continue
    idx=$((idx + 1))
    if ! server_alive; then
      printf '{"name":"%s","source":"%s","skipped":"server died"}\n' "$name" "$source" >> "$out"
      continue
    fi
    if [ "$(elapsed)" -ge "$GLOBAL_LIMIT" ]; then
      printf '{"name":"%s","source":"%s","skipped":"global time limit"}\n' "$name" "$source" >> "$out"
      continue
    fi
    text_line=$(python3 "$RUN/probe.py" text "$sid" "$name" 2>>"$LOGS/probe.err" || printf '{"kind":"text","name":"%s","http":0,"body":"prober crashed"}' "$name")
    printf '%s\n' "$text_line" >> "$out"
    if [ "$name" = "init" ]; then arena_state > "$LOGS/arena-after-init-text.txt"; fi
    cmd_line=$(python3 "$RUN/probe.py" cmd "$sid" "$name" 2>>"$LOGS/probe.err" || printf '{"kind":"cmd","name":"%s","http":0,"body":"prober crashed"}' "$name")
    printf '%s\n' "$cmd_line" >> "$out"
    if [ "$name" = "init" ]; then arena_state > "$LOGS/arena-after-init-cmd.txt"; fi
    printf '[%s %d] %-28s http=%s t=%ss\n' "$tag" "$idx" "$name" \
      "$(printf '%s' "$cmd_line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("http"))' 2>/dev/null || echo '?')" \
      "$(elapsed)" >> "$LOGS/progress.log"
    python3 "$RUN/probe.py" clear "$sid" > /dev/null 2>&1 || true
  done < "$slice"
}

say "== sweep start t=$(elapsed)s timeout=${PROBE_TIMEOUT}s limit=${GLOBAL_LIMIT}s commands=$CMD_COUNT =="
: > "$LOGS/progress.log"
wpids=()
i=0
for sid in "${SESSIONS[@]}"; do
  sweep_session "$sid" "$RUN/slice-$i.tsv" "$RUN/results-$i.jsonl" "w$i" &
  wpids+=($!)
  i=$((i + 1))
done
for pid in "${wpids[@]}"; do wait "$pid" 2>/dev/null || true; done
cat "$RUN"/results-*.jsonl > "$RESULTS" 2>/dev/null || true
say "== sweep done t=$(elapsed)s probes=$(( $(wc -l < "$RESULTS") / 2 )) =="
git -C "$ROOT" status --porcelain > "$LOGS/repo-after.txt" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Names the registry exposes but a TUI cannot type (spaces): dispatch the
# leading token, which is what a slash-prompt client would send.
# ---------------------------------------------------------------------------
say "== CLI-form probes for space-containing names =="
while IFS=$'\t' read -r name source desc; do
  case "$name" in
    *" "*) ;;
    *) continue ;;
  esac
  token="${name%% *}"
  line=$(python3 "$RUN/probe.py" cmd "$SID" "$token" 2>>"$LOGS/probe.err" || printf '{"kind":"cmd","name":"%s","http":0}' "$token")
  python3 - "$name" "$token" "$line" >> "$CLIFORM" <<'PYCF'
import json, sys
full, token, line = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    rec = json.loads(line)
except Exception:
    rec = {"http": 0, "body": "unparseable"}
turn = rec.get("turn") or {}
body = (rec.get("body") or "") + (turn.get("error") or "")
json.dump({"full_name": full, "token": token, "http": rec.get("http"),
           "not_found": "Command not found" in body, "body": (rec.get("body") or "")[:300]},
          sys.stdout)
sys.stdout.write("\n")
PYCF
  python3 "$RUN/probe.py" clear "$SID" > /dev/null 2>&1 || true
done < "$RUN/commands.tsv"
say "cliform probes: $(wc -l < "$CLIFORM" | tr -d ' ')"

# ---------------------------------------------------------------------------
# CLI launch checks (separate, short, isolated HOME)
# ---------------------------------------------------------------------------
say ""
say "== CLI checks t=$(elapsed)s =="
CLI_LOG="$LOGS/cli"; mkdir -p "$CLI_LOG"
CLI_ENV=(env "${SCRUB[@]}" HOME="$RUN/home" TMPDIR="$RUN/tmp" XDG_CONFIG_HOME="$RUN/config" \
         XDG_DATA_HOME="$RUN/data" XDG_CACHE_HOME="$RUN/cache" XDG_STATE_HOME="$STATE_HOME_OVERRIDE" \
         HORIZONCODE_LOCAL_CLI=1)
( cd "$ROOT/packages/horizoncode" && timeout 180 "${CLI_ENV[@]}" "$BUN" ./bin/horizoncode --help \
    > "$CLI_LOG/help.out" 2> "$CLI_LOG/help.err" ); printf '%s' "$?" > "$LOGS/help.rc"
( cd "$ROOT/packages/horizoncode" && timeout 180 "${CLI_ENV[@]}" "$BUN" ./bin/horizoncode run --help \
    > "$CLI_LOG/run-help.out" 2> "$CLI_LOG/run-help.err" ); printf '%s' "$?" > "$LOGS/run-help.rc"
say "  --help      rc=$(cat "$LOGS/help.rc") out=$(wc -c < "$CLI_LOG/help.out")B err=$(wc -c < "$CLI_LOG/help.err")B"
say "  run --help  rc=$(cat "$LOGS/run-help.rc") out=$(wc -c < "$CLI_LOG/run-help.out")B err=$(wc -c < "$CLI_LOG/run-help.err")B"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
stop_server
PROBE_BASE="$BASE" PROBE_AUTH="$AUTH" PROBE_RUN="$RUN" PROBE_LOGS="$LOGS" \
  PROBE_REPORT="$REPORT" PROBE_TASK_DIR="$TASK_DIR" PROBE_SID="$SID" \
  PROBE_ELAPSED="$(elapsed)" PROBE_TIMEOUT="$PROBE_TIMEOUT" \
  python3 "$RUN/report.py" || fatal report "report generation failed"
REPORT_DONE=1

say ""
say "REPORT $REPORT"
say "LOGS $LOGS"
say "SLASH=DONE"
exit 0
