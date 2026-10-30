#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Fullstack build journey: HorizonCode implements a real product from a brief.
#
#   bench/fullstack/meterbase/TASK.md   <- the brief (the agent's only spec)
#   scripts/e2e/fullstack-hidden/       <- graded acceptance suite (held back)
#
# The agent under test gets a session whose cwd IS the task directory, in
# danger-full-access / approvalPolicy=never, and is told to implement TASK.md
# end to end. Afterwards the held-back suite is copied in, run against a
# freshly seeded database, and the per-test verdict is reported.
#
# Nothing here implements the product. This script only builds the arena.
#
# Usage:
#   bash scripts/e2e/fullstack-build.sh
#   HZ_FULLSTACK_TASK=/path/to/task bash scripts/e2e/fullstack-build.sh
#   HZ_FULLSTACK_KEEP=1 bash scripts/e2e/fullstack-build.sh   # keep scratch
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

TASK_NAME="${HZ_FULLSTACK_TASK_NAME:-meterbase}"
TASK_DIR="${HZ_FULLSTACK_TASK:-$ROOT/bench/fullstack/$TASK_NAME}"
SNAP_DIR="${HZ_FULLSTACK_SNAPSHOT:-$ROOT/bench/fullstack/$TASK_NAME-base}"
HIDDEN_SRC="$ROOT/scripts/e2e/fullstack-hidden"

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum | cut -c1-8)"
RUN="$E2E/fs-$RUN_TAG"
LOGS="$E2E/logs/fullstack-$RUN_ID"
STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
PROJECT="$TASK_DIR"
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
DIST_BIN="$ROOT/packages/horizoncode/dist/opencode-linux-x64/bin/opencode"
SERVE_MODE="${HZ_SERVE_MODE:-source}"

PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
case "$PROVIDER_ID" in
  nvidia) KEY_VAR=NVIDIA_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  *) printf 'FULLSTACK=FAIL\nEVIDENCE_FAIL step=env detail=unsupported provider %s\n' "$PROVIDER_ID" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }

fatal() {
  say "FULLSTACK=FAIL"
  say "EVIDENCE_FAIL step=$1 detail=$2"
  exit 1
}

SERVER_PID=""
APPROVER_PID=""
BASE=""
AUTH=""
SID=""

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  if [ -n "$APPROVER_PID" ] && kill -0 "$APPROVER_PID" 2>/dev/null; then kill -TERM "$APPROVER_PID" 2>/dev/null; fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    pkill -KILL -P "$SERVER_PID" 2>/dev/null || true
  fi
  [ "${HZ_FULLSTACK_KEEP:-0}" = "1" ] || rm -rf "$RUN"
  rm -rf "$STATE_HOME_OVERRIDE" 2>/dev/null || true
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[ -s "$TASK_DIR/TASK.md" ] || fatal env "missing task brief: $TASK_DIR/TASK.md"
[ -s "$HIDDEN_SRC/acceptance.test.ts" ] || fatal env "missing held-back suite: $HIDDEN_SRC/acceptance.test.ts"
[ -x "$KERNEL_BIN" ] || fatal host-kernel "missing kernel binary $KERNEL_BIN (cargo build -p hz-kernel)"
ORIG_HOME="${HOME:-/nonexistent}"
# A non-login `bash -c` does not read the login profile, so the user's bun
# directory is not on $PATH by default. Put it there before probing.
export PATH="$ORIG_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || fatal env "bun is not on PATH and not at $ORIG_HOME/.bun/bin/bun"
[ -x "$BUN" ] || fatal env "bun is not executable: $BUN"

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
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-fs-$RANDOM-$RANDOM}"
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"

HOST_SOCK="$STATE_HOME_OVERRIDE/opencode/session-observer/ses_0123456789abcdefghij.sock"
if [ "${#HOST_SOCK}" -ge 108 ]; then
  fatal env "observer socket path is ${#HOST_SOCK} bytes (>=108): $STATE_HOME_OVERRIDE"
fi

# models.dev caches its snapshot under a content-hashed name (models-<hash>.json)
# and leaves models.json.*.tmp turds behind, so resolve the newest real snapshot.
if [ -z "${HZ_MODELS_SNAPSHOT:-}" ]; then
  HZ_MODELS_SNAPSHOT="$(ls -t "$ORIG_HOME"/.cache/opencode/models*.json 2>/dev/null | grep -v 'meta\.json$' | head -n1)"
fi
if [ -z "${HZ_MODELS_SNAPSHOT:-}" ] || [ ! -f "$HZ_MODELS_SNAPSHOT" ]; then
  fatal catalog "no models.dev snapshot under $ORIG_HOME/.cache/opencode (set HZ_MODELS_SNAPSHOT)"
fi
mkdir -p "$XDG_CACHE_HOME/opencode"
cp -f "$HZ_MODELS_SNAPSHOT" "$XDG_CACHE_HOME/opencode/models.json"
# models.dev publishes an 8192-token output limit for the pinned Nemotron, but
# the provider accepts far more (verified: max_tokens=32768 -> HTTP 200 with a
# tool call). A reasoning model that spends its entire 8192-token budget on
# reasoning returns finish_reason=length with zero output tokens, which kills
# the loop mid-build, so the seeded catalog advertises a workable budget.
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
say "CATALOG models.dev snapshot $(wc -c < "$XDG_CACHE_HOME/opencode/models.json") bytes"

# ---------------------------------------------------------------------------
# Pristine reset: the arena is rebuilt from the snapshot every run so a previous
# attempt cannot leak into the next one.
# ---------------------------------------------------------------------------
if [ ! -d "$SNAP_DIR" ]; then
  [ -s "$TASK_DIR/package.json" ] || fatal env "arena looks incomplete (no package.json): $TASK_DIR"
  cp -a "$TASK_DIR" "$SNAP_DIR" || fatal env "could not snapshot $TASK_DIR -> $SNAP_DIR"
  rm -rf "$SNAP_DIR/.data" "$SNAP_DIR/test/hidden"
  say "ARENA snapshot created: $SNAP_DIR"
fi
rm -rf "$TASK_DIR"
cp -a "$SNAP_DIR" "$TASK_DIR" || fatal env "could not restore arena from $SNAP_DIR"
rm -rf "$TASK_DIR/.data" "$TASK_DIR/test/hidden"
say "ARENA task=$TASK_DIR (reset from snapshot)"

# ---------------------------------------------------------------------------
# HostKernel wrapper (source mode: the kernel binary is the repo-local build)
# ---------------------------------------------------------------------------
if [ "$SERVE_MODE" = "dist" ] && [ -x "$DIST_BIN" ]; then
  SERVE_BIN="$DIST_BIN"
else
  SERVE_MODE="source"
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
fi

# ---------------------------------------------------------------------------
# Env scrub: only the provider credential + server password survive
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
# Boot the real server
# ---------------------------------------------------------------------------
start_server() {
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  BASE="http://127.0.0.1:$port"
  : > "$LOGS/serve.log"
  if [ "$SERVE_MODE" = "dist" ]; then
    ( cd "$PROJECT" && exec env "${SCRUB[@]}" \
        HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 HORIZONCODE_LOCAL_CLI=1 \
        "$SERVE_BIN" serve --hostname 127.0.0.1 --port "$port" ) >>"$LOGS/serve.log" 2>&1 &
  else
    ( cd "$ROOT" && exec env "${SCRUB[@]}" \
        HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 HORIZONCODE_LOCAL_CLI=1 \
        "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" --print-logs serve --hostname 127.0.0.1 --port "$port" ) >>"$LOGS/serve.log" 2>&1 &
  fi
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

# Background auto-approver for tool permissions only.
(
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    body=$(curl -sS --max-time 3 "$BASE/permission" -H "Authorization: $AUTH" 2>/dev/null || true)
    ids=$(printf '%s' "$body" | python3 -c '
import json,sys
try: data=json.load(sys.stdin)
except Exception: sys.exit(0)
for row in data if isinstance(data,list) else []:
    if isinstance(row,dict) and row.get("id"):
        print(row["id"])
' 2>/dev/null || true)
    for id in $ids; do
      curl -sS --max-time 5 -X POST "$BASE/permission/$id/reply" -H "Authorization: $AUTH" \
        -H 'content-type: application/json' -d '{"reply":"always"}' >/dev/null 2>&1 || true
    done
    sleep 1
  done
) &
APPROVER_PID=$!

# ---------------------------------------------------------------------------
# Session + kernel-owned posture
# ---------------------------------------------------------------------------
create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d "{\"title\":\"fullstack-$TASK_NAME\"}" 2>/dev/null || echo 000)
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
# The prompt: the brief is the spec, the docs are the reference
# ---------------------------------------------------------------------------
HZ_BUN_PATH="$BUN" python3 - "$TASK_DIR" "$PROVIDER_ID" "$MODEL_ID" > "$LOGS/prompt-request.json" <<'PYPROMPT'
import json, os, sys
task_dir, provider, model = sys.argv[1:4]
override = os.environ.get("HZ_FULLSTACK_PROMPT")
text = """You are the engineer on call. Your working directory is %s and it contains TASK.md, the product brief.

Read TASK.md first, in full, then implement the entire service it describes. This is a real deliverable, not a sketch: the HTTP API, the SQLite schema and migrations, the pricing engine, idempotency, pagination, webhook signing and verification, RFC 9457 errors, the rate limiter, and the server-rendered dashboard. Everything must actually run.

Working rules:
- Work only inside the current working directory. Do not modify anything outside it.
- Use the search tool to look up the external specifications listed under "Documentation requirement" in TASK.md. Do not answer those parts from memory: the signature scheme, the problem-details members, the bearer challenge, the RateLimit-* field semantics and the ISO 4217 exponents all have exact published shapes, and getting them wrong is a customer-visible bug.
- Read the responses you get back and act on them. If a lookup fails, try another query or another source before falling back on your own knowledge.
- One targeted lookup per specification is enough. Budget a handful of steps for documentation, then write the code; do not spend the session reading docs.
- Verify as you go: run `bun run seed`, start the server, exercise the endpoints with curl or your own tests, and run `bun test`. A route you have not called is a route you have not built.
- Keep the existing tests passing and add tests for the behaviour you implement.
- Finish by writing docs/provenance.md (every URL you actually opened, one per line, with what you took from it) and docs/DECISIONS.md (5-10 short bullets).

Do not stop at a plan, and do not stop after the first green test. Implement everything, verify it, and only then report what you built, what you verified, and anything you could not finish.
""" % task_dir
text += "\nThe Bun runtime is at %s and is already on PATH.\n" % os.environ.get("HZ_BUN_PATH", "bun")
print(json.dumps({
    "model": {"providerID": provider, "modelID": model},
    "parts": [{"type": "text", "text": override if override else text}],
}))
PYPROMPT
[ -s "$LOGS/prompt-request.json" ] || fatal prompt "could not build the prompt request"

T0=$(python3 -c 'import time; print(time.time())')
say "prompt: sending to $PROVIDER_ID/$MODEL_ID (t0=$T0)"
prompt_status=$(curl -sS --max-time 5400 -o "$LOGS/prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/prompt-request.json" 2>/dev/null || echo 000)
[ "$prompt_status" = "200" ] || fatal prompt-http "HTTP $prompt_status: $(head -c 400 "$LOGS/prompt-response.json")"

deadline=$((SECONDS + 5400))
while :; do
  curl -sS --max-time 15 "$BASE/session/$SID/message?limit=200" -H "Authorization: $AUTH" \
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
say "prompt: finished state=${state:-unknown} elapsed=$(python3 -c "print(round($T1-$T0,1))")s"

ElapsedSec=$(python3 -c "print(round($T1-$T0,1))")

# ---------------------------------------------------------------------------
# Tool trace: what the agent actually did, from the message parts
# ---------------------------------------------------------------------------
python3 - "$LOGS/messages.json" "$LOGS/trace.txt" > "$LOGS/trace.env" <<'PYTRACE'
import json, re, sys, collections
src, out_path = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
counts = collections.Counter()
errors = collections.Counter()
messages = collections.Counter()
lines = []
step = 0
for m in msgs:
    if not isinstance(m, dict):
        continue
    for p in (m.get("parts") or []):
        if not isinstance(p, dict) or p.get("type") != "tool":
            continue
        step += 1
        name = p.get("tool") or ""
        st = p.get("state") if isinstance(p.get("state"), dict) else {}
        status = st.get("status") or "unknown"
        inp = st.get("input")
        try:
            blob = json.dumps(inp, ensure_ascii=False)
        except Exception:
            blob = str(inp)
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

# The build window is over: stop the agent's server so grading runs against a
# freshly seeded database instead of whatever state the attempt left behind.
if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
  pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
fi
SERVER_PID=""
if [ -n "$APPROVER_PID" ] && kill -0 "$APPROVER_PID" 2>/dev/null; then kill -TERM "$APPROVER_PID" 2>/dev/null; fi
APPROVER_PID=""

# ---------------------------------------------------------------------------
# Deliverable inventory
# ---------------------------------------------------------------------------
python3 - "$TASK_DIR" > "$LOGS/inventory.env" <<'PYINV'
import os, sys
root = sys.argv[1]
files = []
for base, dirs, names in os.walk(root):
    dirs[:] = [d for d in dirs if d not in (".data", "node_modules", ".git", "hidden")]
    for name in names:
        path = os.path.join(base, name)
        rel = os.path.relpath(path, root)
        try:
            lines = sum(1 for _ in open(path, encoding="utf-8", errors="ignore"))
        except Exception:
            lines = 0
        files.append((rel, lines))
src = [(f, n) for f, n in files if f.startswith("src/") or f.startswith("test/")]
print("FILES_TOTAL=%d" % len(files))
print("FILES_SRC=%d" % len(src))
print("LOC_SRC=%d" % sum(n for _, n in src))
for f, n in sorted(files):
    print("FILE %s %d" % (f, n))
PYINV

# ---------------------------------------------------------------------------
# Held-back acceptance suite
# ---------------------------------------------------------------------------
# The agent's own suite runs first, while the held-back tests are not present.
( cd "$TASK_DIR" && NO_COLOR=1 timeout 600 "$BUN" test > "$LOGS/agent-tests.out" 2>&1 )
agent_rc=$?

mkdir -p "$TASK_DIR/test/hidden"
cp "$HIDDEN_SRC/acceptance.test.ts" "$TASK_DIR/test/hidden/acceptance.test.ts"
say "grading: running the held-back acceptance suite"
( cd "$TASK_DIR" && NO_COLOR=1 timeout 900 "$BUN" test test/hidden/ > "$LOGS/acceptance.out" 2>&1 )
accept_rc=$?

python3 - "$LOGS/acceptance.out" > "$LOGS/acceptance.env" <<'PYACC'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
rows = []
for line in text.splitlines():
    m = re.match(r"^\((pass|fail)\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?$", line.strip())
    if m:
        rows.append((m.group(1), m.group(2).strip()))
passed = sum(1 for s, _ in rows if s == "pass")
failed = sum(1 for s, _ in rows if s == "fail")
if not rows:
    # fall back to bun's summary block
    mp = re.search(r"^\s*(\d+)\s+pass\s*$", text, re.M)
    mf = re.search(r"^\s*(\d+)\s+fail\s*$", text, re.M)
    passed = int(mp.group(1)) if mp else 0
    failed = int(mf.group(1)) if mf else 0
print("ACCEPT_PASS=%d" % passed)
print("ACCEPT_FAIL=%d" % failed)
print("ACCEPT_TOTAL=%d" % (passed + failed))
for status, name in rows:
    print("ACCEPT %s %s" % (status.upper(), name))
if not rows:
    tail = "\n".join(text.splitlines()[-25:])
    print("ACCEPT_RAW_TAIL<<EOF")
    print(tail)
    print("EOF")
PYACC

# Provenance: URLs the agent says it opened, cross-checked against its searches.
python3 - "$TASK_DIR" "$LOGS/trace.txt" > "$LOGS/provenance.env" <<'PYPROV'
import os, re, sys
task, trace_path = sys.argv[1], sys.argv[2]
prov = os.path.join(task, "docs", "provenance.md")
urls, host_counts = [], {}
if os.path.exists(prov):
    for line in open(prov, encoding="utf-8", errors="ignore"):
        for url in re.findall(r"https?://[^\s)>\]]+", line):
            url = url.rstrip(".,;`\"'")
            if url not in urls:
                urls.append(url)
host = lambda u: re.sub(r"^https?://([^/]+).*$", r"\1", u)
for url in urls:
    host_counts[host(url)] = host_counts.get(host(url), 0) + 1
search_calls = 0
fetch_calls = 0
for line in open(trace_path, encoding="utf-8", errors="replace"):
    cols = line.split()
    if len(cols) < 3:
        continue
    tool = cols[1]
    if tool in ("search", "websearch", "web_search", "web.search"):
        search_calls += 1
    elif tool in ("webfetch", "web_fetch", "fetch"):
        fetch_calls += 1
print("PROV_DOC=%s" % ("yes" if os.path.exists(prov) else "no"))
print("PROV_URLS=%d" % len(urls))
print("PROV_HOSTS=%d" % len(host_counts))
print("PROV_TRACE_SEARCH_CALLS=%d" % search_calls)
print("PROV_TRACE_FETCH_CALLS=%d" % fetch_calls)
for h, n in sorted(host_counts.items(), key=lambda kv: -kv[1])[:12]:
    print("PROV_HOST %s %d" % (h, n))
for url in urls[:40]:
    print("PROV_URL %s" % url)
PYPROV

python3 - "$LOGS/inventory.env" > "$LOGS/inv.json" <<'PYJ'
import json, sys
rows = [l.rstrip("\n") for l in open(sys.argv[1], encoding="utf-8")]
print(json.dumps(rows))
PYJ

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
REPORT_DIR="$ROOT/reports/fullstack"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/run-$RUN_ID.md"

getval() { grep "^$1=" "$LOGS/$2" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

{
  printf '# Fullstack build run %s\n\n' "$RUN_ID"
  printf -- '- task: `%s`\n- provider/model: `%s/%s`\n- serve mode: `%s`\n- wall clock: %ss\n- tool calls: %s\n- tool errors: %s\n\n' \
    "$TASK_NAME" "$PROVIDER_ID" "$MODEL_ID" "$SERVE_MODE" "$ElapsedSec" \
    "$(getval TOOL_CALLS trace.env)" "$(getval TOOL_ERRORS trace.env)"
  printf '## Held-back acceptance\n\n'
  printf '| verdict | count |\n| --- | --- |\n| pass | %s |\n| fail | %s |\n\n' \
    "$(getval ACCEPT_PASS acceptance.env)" "$(getval ACCEPT_FAIL acceptance.env)"
  grep '^ACCEPT ' "$LOGS/acceptance.env" 2>/dev/null | sed 's/^ACCEPT /- /' || true
  printf '\n## Agent-authored suite\n\n```\n'
  tail -n 12 "$LOGS/agent-tests.out" 2>/dev/null || true
  printf '\n```\n\n## Provenance\n\n'
  printf -- '- docs/provenance.md: %s\n- distinct URLs: %s across %s hosts\n- search tool calls in trace: %s\n\n' \
    "$(getval PROV_DOC provenance.env)" "$(getval PROV_URLS provenance.env)" \
    "$(getval PROV_HOSTS provenance.env)" "$(getval PROV_TRACE_SEARCH_CALLS provenance.env)"
  grep '^PROV_HOST ' "$LOGS/provenance.env" 2>/dev/null | sed 's/^PROV_HOST /- /' || true
  printf '\n## Files\n\n'
  printf -- '- total: %s, source/test: %s, LOC: %s\n\n' \
    "$(getval FILES_TOTAL inventory.env)" "$(getval FILES_SRC inventory.env)" "$(getval LOC_SRC inventory.env)"
  printf '## Tool mix\n\n```\n'
  grep '^TOOL_' "$LOGS/trace.env" 2>/dev/null || true
  printf '```\n'
} > "$REPORT"

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
ACC_PASS=$(getval ACCEPT_PASS acceptance.env)
ACC_FAIL=$(getval ACCEPT_FAIL acceptance.env)
PROV_URLS=$(getval PROV_URLS provenance.env)
TOOL_CALLS=$(getval TOOL_CALLS trace.env)

# Keep the arena for inspection but drop the held-back suite from it.
rm -rf "$TASK_DIR/test/hidden"

say ""
say "ACCEPTANCE pass=$ACC_PASS fail=$ACC_FAIL (rc=$accept_rc)"
say "AGENT_TESTS rc=$agent_rc"
say "TOOL_CALLS=$TOOL_CALLS"
say "PROVENANCE urls=$PROV_URLS doc=$(getval PROV_DOC provenance.env)"
say "REPORT $REPORT"
say "TRACE $LOGS/trace.txt"
say "LOGS $LOGS"
if [ "$ACC_FAIL" = "0" ] && [ "$ACC_PASS" != "0" ]; then
  say "FULLSTACK=VERIFIED"
  exit 0
fi
say "FULLSTACK=PARTIAL"
exit 2
