#!/usr/bin/env bash
# HorizonCode V1 offline cancel + restart recovery E2E journey.
#
# Attacks tracker rows FIN-02 ("Not done": no kill-mid-stream / restart /
# no-duplicate-message journey) and UI-017 (reconnect / kill mid-stream,
# no duplicate). ALL local: no network, no provider calls, no paid route.
#
# Provider traffic goes to a repo-local slow-streaming fake OpenAI-compatible
# LLM (python3, binds 127.0.0.1 only). HorizonCode's only credential-free
# direct lane is the catalog-backed anonymous `opencode` provider offer
# (literal apiKey "public", active + fully zero-priced models, loopback-http
# endpoints admitted), so the mock is registered as catalog model
# opencode/e2e-offline (cost 0) through an inline catalog (OPENCODE_MODELS_PATH)
# whose api endpoint is the mock. A primary AgentProfileV2 (user.e2e@1) in the
# global user config pins that exact model so the direct provider-authority
# gate admits the turn. The mock NEVER completes its scripted stream: it
# streams a `write` tool-call slowly and then hangs, so every prompt is still
# mid-stream when the journey acts on it. Models fetch is disabled; provider
# API-key env vars are scrubbed from the serve environment. Direct turns are
# also gated on the REAL HostKernel permission-mode snapshot; source-mode
# `bun run` has no build-time defines, so the repo-local `hz-kernel` binary
# (same one live Core tests use) is injected via bun --preload globals - the
# real kernel runs, no gate is mocked or weakened. If no repo-local kernel
# binary exists, the journey fails closed with a labeled step.
#
# JOURNEY (per run, all offline):
#   Leg A - cancel mid-stream:
#     create session, POST a slow prompt in the background, wait until the
#     assistant tool-call is streaming, POST /session/:id/abort mid-stream.
#     Assert: session settles to idle (not stuck); the aborted turn is NOT
#     reported as a successful completion (fail-closed); the write target file
#     was never created; and no blind automatic retry re-invoked the model/tool
#     after cancel (mock request count frozen, assistant count still 1).
#   Leg B - SIGKILL mid-stream + restart against the SAME state/data dir:
#     create a second session, start another slow prompt, SIGKILL `serve`
#     while it streams, restart serve with identical HOME/XDG state dirs.
#     Assert: on reconnect the session and journal parse cleanly; message and
#     part IDs are unique (no duplicate assistant messages / tool results);
#     no NEW assistant ids appeared (no replay); the mock request count did
#     not increase (no automatic re-prompt after restart); the interrupted
#     turn is NOT reported as a clean success (fail-closed); cost stays 0;
#     no committed partial target file; the old server stays dead.
#
# Fail-closed: any failed assertion exits non-zero with a labeled step, the
# E2E_V1_CANCEL_RESTART=FAIL marker, and evidence. Success prints
# E2E_V1_CANCEL_RESTART=PASS plus evidence lines.
#
# Isolation: HOME/XDG/TMPDIR live under .tmp/e2e/v1cr (short by design - see
# the Unix-socket budget note above); per-run evidence lives in
# .tmp/e2e/logs/v1-cancel-restart-$RUN_ID (accumulates on
# purpose - reclaim manually when no run is active:
#   rm -rf .tmp/e2e/logs/v1-cancel-restart-*
# The mock LLM and the server are always killed via trap.
#
# Usage:
#   bash scripts/e2e/v1-cancel-restart.sh
#   BUN=/path/to/bun bash scripts/e2e/v1-cancel-restart.sh   # optional pin
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/.tmp/e2e"
# Working dir is intentionally SHORT: with the HostKernel wired up, the session
# observer and kernel bind Unix sockets under XDG_STATE_HOME
# (<run>/state/opencode/session-observer/s-<16>.sock), and Linux sun_path is
# capped at 107 bytes (supervisor validateSocketPath). The repo root alone
# costs 33 bytes, so a long run-dir name overflows the socket path and boot
# fails closed with "Unix socket path is too long".
RUN="$E2E/v1cr"
# Unique per-run identity (timestamp + PID): isolates this run's logs from
# every prior/concurrent run so a stale artifact can never satisfy this run.
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LOGS="$E2E/logs/v1-cancel-restart-$RUN_ID"
WORK="$RUN/work"
LLM_LOG="$LOGS/llm-hits.jsonl"

ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_STATE_HOME="$RUN/state"
export XDG_CACHE_HOME="$RUN/cache"
export OPENCODE_TEST_HOME="$RUN/home"
export PATH="$ORIG_HOME/.bun/bin:$PATH"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-v1-cancelrestart-$RANDOM-$RANDOM}"
# Fully offline serve posture (same affordances as test/lib/cli-process.ts).
export OPENCODE_DISABLE_PROJECT_CONFIG=1
export OPENCODE_PURE=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_AUTOCOMPACT=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_AUTH_CONTENT="{}"

mkdir -p "$RUN/config" "$RUN/data" "$RUN/state" "$RUN/cache" "$RUN/home" "$RUN/tmp" "$WORK" "$LOGS"

BUN="${BUN:-}"
if [ -z "$BUN" ] && [ -x "$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun" ]; then
  BUN="$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun"
fi
if [ -z "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [ -z "$BUN" ] && [ -x "$ORIG_HOME/.bun/bin/bun" ]; then BUN="$ORIG_HOME/.bun/bin/bun"; fi

SERVER_PID=""
OLD_SERVER_PID=""
MOCK_PID=""
APPROVER_PID=""
PROMPT_A_PID=""
PROMPT_B_PID=""
BASE=""
FIRST_BASE=""
ABORT_STATUS=""
SID_A=""
SID_B=""

say() { printf '%s\n' "$*"; }

cap_logs() {
  [ -d "$LOGS" ] || return 0
  for f in "$LOGS"/*; do
    [ -f "$f" ] || continue
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    if [ "${sz:-0}" -gt 1048576 ]; then
      tail -c 1048576 "$f" > "$f.cap" 2>/dev/null && mv "$f.cap" "$f"
    fi
  done
}

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  for pid in "$PROMPT_A_PID" "$PROMPT_B_PID" "$APPROVER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null
    fi
  done
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    pkill -KILL -P "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill -TERM "$MOCK_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$MOCK_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN"
  cap_logs
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
llm_hits() { # slow-stream mock requests for one leg tag (retry detector)
  local n
  n=$(grep -c "\"tag\":\"$1\"" "$LLM_LOG" 2>/dev/null) || n=0
  printf '%s' "$n"
}
llm_hits_total() { wc -l < "$LLM_LOG" 2>/dev/null | tr -d ' ' || printf '0'; }

getval_from() { # $1 env-file $2 key
  grep "^$2=" "$1" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

fail() {
  step=$1
  shift
  say "E2E_V1_CANCEL_RESTART=FAIL"
  say "EVIDENCE upto=$step session_a=${SID_A:-none} session_b=${SID_B:-none} abort=${ABORT_STATUS:-none} base=${BASE:-none} llm_hits_total=$(llm_hits_total)"
  say "EVIDENCE_FAIL step=$step detail=$(printf '%s' "$*" | cut -c1-600)"
  # Surface the last turn's error directly: the assistant message carries the
  # exact gate failure (HostKernel / provider-authority / LLM) that killed it.
  for pr in "$LOGS/legA-prompt-response.json" "$LOGS/legB-prompt-response.json"; do
    [ -s "$pr" ] || continue
    perr=$(python3 - "$pr" <<'PY' 2>/dev/null
import json, sys
try:
    info = json.load(open(sys.argv[1], encoding="utf-8")).get("info") or {}
    err = info.get("error")
    print(json.dumps(err)[:500] if err else "")
except Exception:
    print("")
PY
)
    [ -n "$perr" ] && say "EVIDENCE_FAIL $(basename "$pr") error=$perr"
  done
  # Preserve application + kernel logs before the run dir is cleaned up.
  if [ -d "$XDG_DATA_HOME/opencode/log" ]; then
    cp -r "$XDG_DATA_HOME/opencode/log" "$LOGS/app-log" 2>/dev/null || true
  fi
  find "$XDG_STATE_HOME" -name '*.log' -size -8M 2>/dev/null | head -n 12 | while read -r klog; do
    cp "$klog" "$LOGS/state-$(basename "$klog")" 2>/dev/null || true
  done
  if [ -s "$LOGS/serve.log" ]; then
    say "--- serve.log tail ---"
    tail -n 15 "$LOGS/serve.log" | cut -c1-400
  fi
  if [ -s "$LOGS/mock.out" ]; then
    say "--- mock.out tail ---"
    tail -n 10 "$LOGS/mock.out" | cut -c1-400
  fi
  say "LOGS=$LOGS"
  exit 1
}

expect_eq() { # $1 actual $2 expected $3 step-label
  [ "$1" = "$2" ] || fail "$3" "expected [$2], got [$1]"
}

session_status() { # $1 sid -> idle | busy | absent | error
  local out="$LOGS/status.json"
  curl -sS --max-time 10 "$BASE/session/status" -H "Authorization: $AUTH" -o "$out" 2>/dev/null || { printf 'error'; return; }
  python3 - "$out" "$1" <<'PY' 2>/dev/null || printf 'error'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
row = data.get(sys.argv[2]) if isinstance(data, dict) else None
print(row.get("type", "idle") if isinstance(row, dict) else "idle")
PY
}

# ---------------------------------------------------------------------------
# 0. Fail-closed prerequisites
# ---------------------------------------------------------------------------
[ -n "$BUN" ] || fail env "bun not found (checked \$BUN, .tmp/tools/bun-1.3.14, PATH, \$HOME/.bun/bin)"
command -v python3 >/dev/null 2>&1 || fail env "python3 not found (needed for the offline mock LLM + JSON parsing)"
command -v curl >/dev/null 2>&1 || fail env "curl not found"
[ "$OPENCODE_SERVER_PASSWORD" != "" ] || fail env "OPENCODE_SERVER_PASSWORD must be non-empty"
AUTH="$(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
AUTH="Basic $AUTH"
say "STEP 1/10: prerequisites ok (bun=$BUN)"

# ---------------------------------------------------------------------------
# 1. Offline slow-stream mock LLM (fake OpenAI-compatible server).
#    Scripted behavior is driven by the prompt text:
#      [SLOWHANG:<tag>]  -> stream a write tool-call slowly, then hang forever
#      "Generate a title..." -> instant tiny reply (title generation)
#      anything else     -> instant tiny reply
#    Every request is appended to $LLM_LOG as one JSON line (the retry detector).
# ---------------------------------------------------------------------------
cat > "$RUN/mock-llm.py" <<'PY'
#!/usr/bin/env python3
import json, os, re, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = sys.argv[1]
TARGET_DIR = sys.argv[2]
LOG_LOCK = threading.Lock()

def log_event(mode, tag, path):
    row = {"t": time.time(), "mode": mode, "tag": tag, "path": path}
    try:
        with LOG_LOCK:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
    except Exception:
        pass

def chunk(delta, finish=None):
    c = {
        "id": "chatcmpl-e2e",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "test-model",
        "choices": [{"index": 0, "delta": delta}],
    }
    if finish:
        c["choices"][0]["finish_reason"] = finish
    return ("data: " + json.dumps(c) + "\n\n").encode()

DONE = b"data: [DONE]\n\n"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    timeout = 900

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models") or self.path.startswith("/models"):
            self._json({"object": "list", "data": [{"id": "test-model", "object": "model"}]})
            return
        self._json({"ok": True, "service": "e2e-mock-llm"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        body = raw.decode("utf-8", "replace")
        if "Generate a title for this conversation" in body:
            log_event("title", "", self.path)
            self._stream_text("E2E Title")
            return
        m = re.search(r"\[SLOWHANG:([A-Za-z0-9_-]+)\]", body)
        if m:
            log_event("slowhang", m.group(1), self.path)
            self._slow_hang(m.group(1))
            return
        log_event("default", "", self.path)
        self._stream_text("ok")

    def _stream_text(self, value):
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({"content": value}))
            self.wfile.write(chunk({}, finish="stop"))
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _slow_hang(self, tag):
        # Streams a write tool-call very slowly and then hangs forever: the
        # turn can never complete on its own, so "mid-stream" is guaranteed
        # whenever the journey acts. The tool call is never finished, so the
        # write tool must never execute - the target file must stay absent.
        target = os.path.join(TARGET_DIR, "%s-target.txt" % tag)
        args = json.dumps({
            "filePath": target,
            "content": "COMMITTED-SUCCESS " + ("x" * 240),
        })
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({
                "tool_calls": [{
                    "index": 0,
                    "id": "call_e2e_1",
                    "type": "function",
                    "function": {"name": "write", "arguments": ""},
                }],
            }))
            self.wfile.flush()
            time.sleep(0.2)
            size = 12
            for i in range(0, len(args), size):
                piece = args[i:i + size]
                self.wfile.write(chunk({
                    "tool_calls": [{"index": 0, "function": {"arguments": piece}}],
                }))
                self.wfile.flush()
                time.sleep(0.4)
            while True:
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(2.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
srv.daemon_threads = True
print("MOCK_READY port=%d" % srv.server_address[1], flush=True)
srv.serve_forever()
PY
: > "$LLM_LOG"
python3 "$RUN/mock-llm.py" "$LLM_LOG" "$WORK" > "$LOGS/mock.out" 2>&1 &
MOCK_PID=$!
MOCK_PORT=""
for _ in $(seq 1 100); do
  MOCK_PORT="$(sed -n 's/^MOCK_READY port=\([0-9]*\)$/\1/p' "$LOGS/mock.out" 2>/dev/null | head -n1)"
  [ -n "$MOCK_PORT" ] && break
  kill -0 "$MOCK_PID" 2>/dev/null || fail mock-llm "mock LLM exited during startup: $(head -c 400 "$LOGS/mock.out" 2>/dev/null)"
  sleep 0.2
done
[ -n "$MOCK_PORT" ] || fail mock-llm "mock LLM never printed its port: $(head -c 400 "$LOGS/mock.out" 2>/dev/null)"
MOCK_BASE="http://127.0.0.1:$MOCK_PORT"
mock_probe=$(curl -sS --max-time 5 "$MOCK_BASE/health" 2>/dev/null || true)
case "$mock_probe" in *e2e-mock-llm*) ;; *) fail mock-llm "mock health probe failed: $mock_probe";; esac
say "STEP 2/10: offline mock LLM up on $MOCK_BASE (pid=$MOCK_PID)"

# ---------------------------------------------------------------------------
# 2a. Inline loopback catalog: register the mock as the catalog-backed
#     anonymous `opencode` provider's model (cost 0, active, tool_call). This
#     is the only credential-free direct lane HorizonCode admits, and it
#     permits loopback-http endpoints - so provider traffic stays 100% local.
# ---------------------------------------------------------------------------
mkdir -p "$RUN/catalog"
python3 - "$RUN/catalog/models.json" "$MOCK_BASE/v1" <<'PY'
import json, sys
out, api = sys.argv[1], sys.argv[2]
catalog = {
    "opencode": {
        "id": "opencode",
        "name": "OpenCode",
        "api": api,
        "npm": "@ai-sdk/openai-compatible",
        "env": [],
        "models": {
            "e2e-offline": {
                "id": "e2e-offline",
                "name": "E2E Offline",
                "status": "active",
                "family": "e2e",
                "tool_call": True,
                "temperature": True,
                "attachment": False,
                "reasoning": False,
                "release_date": "2025-01-01",
                "limit": {"context": 100000, "output": 10000},
                "cost": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
            }
        },
    }
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(catalog, f)
PY
[ -s "$RUN/catalog/models.json" ] || fail catalog "failed to write the offline loopback catalog"
export OPENCODE_MODELS_PATH="$RUN/catalog/models.json"
EVIDENCE_CATALOG="inline-loopback"
say "EVIDENCE catalog=$EVIDENCE_CATALOG model=opencode/e2e-offline api=$MOCK_BASE/v1 cost=0"

# ---------------------------------------------------------------------------
# 2b. Provider config + primary AgentProfileV2.
#     OPENCODE_CONFIG_CONTENT carries the offline posture (no provider block -
#     the provider comes from the anonymous catalog above, so no credential
#     material exists anywhere). The primary AgentProfileV2 must live in the
#     GLOBAL user config FILE: Core Config only trusts profile documents in
#     that directory, and the direct provider-authority gate requires the
#     primary profile's model to equal the pinned turn model. The profile
#     definition is decoded strictly (onExcessProperty: error) - every field
#     below is exact, and a bad profile silently drops the whole file.
# ---------------------------------------------------------------------------
OPENCODE_CONFIG_CONTENT="$(python3 - <<'PY'
import json
print(json.dumps({
    "formatter": False,
    "lsp": False,
    "permission": "allow",
}))
PY
)" || fail config "failed to build OPENCODE_CONFIG_CONTENT"
[ -n "$OPENCODE_CONFIG_CONTENT" ] || fail config "empty OPENCODE_CONFIG_CONTENT"
export OPENCODE_CONFIG_CONTENT

mkdir -p "$XDG_CONFIG_HOME/opencode"
python3 - "$XDG_CONFIG_HOME/opencode/opencode.json" <<'PY'
import json, sys
profile = {
    "schemaVersion": 2,
    "profileId": "user.e2e",
    "revision": "1",
    "name": "e2e",
    "description": "Offline E2E primary profile",
    "source": "user",
    "roles": ["main"],
    "purpose": "Drive the offline cancel/restart E2E journey",
    "whenToUse": "During scripts/e2e/v1-cancel-restart.sh",
    "whenNotToUse": "Never outside the offline E2E journey",
    "adapter": {"kind": "native", "adapterId": "horizon.native"},
    "model": {"providerId": "opencode", "modelId": "e2e-offline"},
    "harness": "native-rich",
    "reasoning": "low",
    "variants": [],
    "instructions": {"extraRefs": [], "maxCompiledTokens": "4096"},
    "tools": [],
    "allowedSkillIds": [],
    "deniedSkillIds": [],
    "allowedMcpServers": [],
    "allowedMcpToolPatterns": [],
    "allowedSubagentIds": [],
    "deniedSubagentIds": [],
    "pathRules": [],
    "context": {"isolation": "fresh", "allowImages": False, "allowDocuments": False, "allowArtifacts": False},
    "inputMode": "default",
    "memoryPolicy": "none",
    "isolation": "workspace",
    "lifecycleHooks": [],
    "capabilityCeiling": [],
    "limits": {"maxDepth": 0, "maxActiveChildren": 0, "maxTotalChildren": 0, "maxPendingMessages": 1, "maxMessageBytes": 65536},
    "maxParallelChildren": 0,
    "enabled": True,
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({
        "agent_profiles": [profile],
        "agent_profile_selectors": [{"selector": "e2e", "profileId": "user.e2e", "revision": "1"}],
        "primary_agent_profile_selector": "e2e",
    }, f)
PY
[ -s "$XDG_CONFIG_HOME/opencode/opencode.json" ] || fail config "failed to write the primary AgentProfileV2 user config"
say "EVIDENCE config content=offline posture profile=user.e2e@1 selector=e2e"

# Scrub EVERY provider credential-looking env var from the serve environment
# (dynamic sweep + explicit canonical list): no key may leak into the server.
PROVIDER_SCRUB=()
while IFS='=' read -r scrub_name _rest; do
  [ -n "$scrub_name" ] || continue
  case "$scrub_name" in
    *API_KEY*|*APIKEY*|*_TOKEN*|*_SECRET*|*SECRET*|*CREDENTIAL*|*PASSWORD*)
      case "$scrub_name" in
        OPENCODE_SERVER_PASSWORD) ;;
        *) PROVIDER_SCRUB+=(-u "$scrub_name") ;;
      esac
      ;;
  esac
done < <(env)
for scrub_name in OPENCODE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY OPENCODE_GO_API_KEY \
  GOOGLE_GENERATIVE_AI_API_KEY OPENROUTER_API_KEY XAI_API_KEY MISTRAL_API_KEY \
  DEEPSEEK_API_KEY GROQ_API_KEY COHERE_API_KEY TOGETHER_API_KEY FIREWORKS_API_KEY; do
  PROVIDER_SCRUB+=(-u "$scrub_name")
done
say "STEP 3/10: config ready (anonymous=true model=opencode/e2e-offline cost=0 base=$MOCK_BASE/v1 scrub_vars=${#PROVIDER_SCRUB[@]} profile=user.e2e@1)"

# ---------------------------------------------------------------------------
# 3b. HostKernel binary: the direct provider-authority gate requires the real
#     HostKernel's permission-mode snapshot, which only exists when the
#     compiled binary's embedded kernel is present. A source-mode `bun run`
#     has no build-time defines (see packages/horizoncode/script/build.ts), so
#     the repo-local hz-kernel binary is injected through bun --preload
#     globals carrying the exact build manifest shape. The REAL kernel runs.
# ---------------------------------------------------------------------------
KERNEL_BIN=""
for kernel_candidate in "$ROOT/kernel/target/debug/hz-kernel" "$ROOT/target-p2/debug/hz-kernel"; do
  if [ -f "$kernel_candidate" ]; then KERNEL_BIN="$kernel_candidate"; break; fi
done
if [ -z "$KERNEL_BIN" ]; then
  KERNEL_BIN="$(find "$ROOT/.tmp" "$ROOT/packages/core/.tmp" -maxdepth 5 -name 'hz-kernel-*' -size +50M 2>/dev/null | head -n1)"
fi
if [ -z "$KERNEL_BIN" ] || [ ! -f "$KERNEL_BIN" ]; then
  fail host-kernel "no repo-local hz-kernel binary found (checked kernel/target/debug, target-p2/debug, .tmp installs); direct turns require the real HostKernel"
fi
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" 2>/dev/null | cut -d' ' -f1)"
case "$KERNEL_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) fail host-kernel "could not sha256sum kernel binary $KERNEL_BIN" ;;
esac
python3 - "$RUN/kernel-preload.ts" "$KERNEL_BIN" "$KERNEL_SHA" <<'PY'
import json, sys
out, asset, sha = sys.argv[1], sys.argv[2], sys.argv[3]
with open(out, "w", encoding="utf-8") as f:
    f.write("// E2E source-mode shim: expose the repo-local HostKernel binary through\n")
    f.write("// the build-time defines the compiled binary embeds (script/build.ts).\n")
    f.write("globalThis.OPENCODE_HOST_KERNEL_MANIFEST = JSON.stringify({\n")
    f.write("  schemaVersion: 1,\n")
    f.write('  status: "available",\n')
    f.write('  binaryName: "hz-kernel",\n')
    f.write('  target: "linux-" + process.arch + "-gnu",\n')
    f.write("  sha256: %s,\n" % json.dumps(sha))
    f.write("})\n")
    f.write("globalThis.OPENCODE_HOST_KERNEL_ASSET = %s\n" % json.dumps(asset))
PY
[ -s "$RUN/kernel-preload.ts" ] || fail host-kernel "failed to write the kernel preload shim"
say "EVIDENCE host_kernel=$KERNEL_BIN sha256=$KERNEL_SHA preload=kernel-preload.ts"
say "STEP 4/10: HostKernel binary wired (real kernel, no gates mocked)"

start_server() {
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
  BASE="http://127.0.0.1:$port"
  : >> "$LOGS/serve.log"
  # Launch as DIRECT file execution from packages/horizoncode, NOT via `bun run`:
  # at that cwd `bun run` swaps the CLI --preload list for the project bunfig's
  # preload (packages/horizoncode/bunfig.toml), silently dropping the kernel shim.
  # Direct execution honors repeatable CLI --preload flags; the bunfig's TUI
  # preload is passed explicitly to keep parity with a normal boot.
  ( cd "$ROOT/packages/horizoncode" && exec env \
      "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
      "$BUN" --preload="@opentui/solid/preload" --preload="$RUN/kernel-preload.ts" \
      src/index.ts serve --hostname 127.0.0.1 --port "$port" ) \
    >>"$LOGS/serve.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 240); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    if curl -fsS --max-time 2 "$BASE/global/health" -H "Authorization: $AUTH" > "$LOGS/health.json" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

boot_server() { # $1 attempt-label
  attempt=0
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    if start_server; then
      return 0
    fi
    say "SERVER: $1 attempt $attempt failed; retrying"; tail -c 400 "$LOGS/serve.log" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  done
  fail server "$1 did not become healthy after 3 attempts"
}

boot_server initial
FIRST_BASE="$BASE"
say "STEP 5/10: serve healthy on $BASE (pid=$SERVER_PID)"

# Background permission auto-approver: a pending ask must never hang the
# non-interactive run. Only permissions are auto-approved; nothing is broadened.
approve_loop() {
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    body=$(curl -sS --max-time 3 "$BASE/permission" -H "Authorization: $AUTH" 2>/dev/null || true)
    ids=$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for row in data if isinstance(data, list) else []:
    if isinstance(row, dict) and isinstance(row.get("id"), str):
        print(row["id"])
' 2>/dev/null || true)
    for id in $ids; do
      curl -sS --max-time 5 -X POST "$BASE/permission/$id/reply" \
        -H "Authorization: $AUTH" -H 'content-type: application/json' \
        -d '{"reply":"always"}' >> "$LOGS/permission.log" 2>&1 || true
    done
    sleep 1
  done
}
approve_loop &
APPROVER_PID=$!

# ---------------------------------------------------------------------------
# Message snapshot parser (journal-consistency + duplicate detectors).
# ---------------------------------------------------------------------------
cat > "$RUN/parse_snapshot.py" <<'PY'
import json, sys

path, marker = sys.argv[1], sys.argv[2]

def out(key, value):
    print("%s=%s" % (key, value))

try:
    data = json.load(open(path, encoding="utf-8"))
except Exception as exc:
    out("PARSEOK", "0")
    out("PARSEERR", str(exc).replace("\n", " ")[:300])
    sys.exit(0)

out("PARSEOK", "1")
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
if not isinstance(msgs, list):
    msgs = []
out("MSGCOUNT", len(msgs))

msg_ids = []
part_ids = []
assistants = []
user_marker = 0
cost_nonzero = 0
tool_parts = 0

for m in msgs:
    if not isinstance(m, dict):
        continue
    info = m.get("info") if isinstance(m.get("info"), dict) else {}
    mid = info.get("id") or m.get("id")
    if isinstance(mid, str):
        msg_ids.append(mid)
    role = info.get("role")
    if role == "user":
        text = ""
        parts0 = m.get("parts") or []
        if isinstance(parts0, list):
            for p in parts0:
                if isinstance(p, dict) and p.get("type") == "text":
                    text += str(p.get("text") or "")
        if marker and marker in text:
            user_marker += 1
    if role == "assistant":
        assistants.append(m)
        cost = info.get("cost")
        if cost not in (0, 0.0, None):
            cost_nonzero = 1
    parts = m.get("parts") or []
    if not isinstance(parts, list):
        parts = []
    for p in parts:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if isinstance(pid, str):
            part_ids.append(pid)
        if p.get("type") == "tool":
            tool_parts += 1

out("DUP_MSG_IDS", len(msg_ids) - len(set(msg_ids)))
out("DUP_PART_IDS", len(part_ids) - len(set(part_ids)))
out("USERMARKERCOUNT", user_marker)
out("ASSISTANTCOUNT", len(assistants))
out("TOOLPARTS", tool_parts)
out("COST_NONZERO", cost_nonzero)
assist_ids = []
for m in assistants:
    info = m.get("info") if isinstance(m.get("info"), dict) else {}
    if isinstance(info.get("id"), str):
        assist_ids.append(info["id"])
out("ASSIST_IDS", ",".join(assist_ids))

if not assistants:
    out("LAST_STATE", "none")
    out("LAST_COMPLETED", "0")
    out("LAST_ERROR", "")
    out("LAST_FINISH", "")
    out("LAST_COST", "missing")
    out("CLEAN_SUCCESS", "0")
    sys.exit(0)

info = assistants[-1].get("info") if isinstance(assistants[-1].get("info"), dict) else {}
timeinfo = info.get("time") if isinstance(assistants[-1].get("info"), dict) and isinstance(assistants[-1]["info"].get("time"), dict) else {}
completed = bool(timeinfo.get("completed"))
err = info.get("error")
out("LAST_STATE", "done" if completed else "running")
out("LAST_COMPLETED", "1" if completed else "0")
out("LAST_ERROR", json.dumps(err)[:400] if err else "")
out("LAST_FINISH", info.get("finish") or "")
cost = info.get("cost")
out("LAST_COST", "null" if cost is None else cost)
# Fail-closed core: a turn whose stream never completed must never be
# presented as a clean successful completion.
out("CLEAN_SUCCESS", "1" if (completed and not err) else "0")
PY

create_session() { # $1 title $2 out-file -> echoes session id
  local title=$1 out=$2 st
  st=$(curl -sS --max-time 30 -o "$out" -w '%{http_code}' \
    -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
    -d "{\"title\":\"$title\"}" 2>/dev/null || echo "000")
  [ "$st" = "200" ] || { say "session create HTTP $st: $(head -c 300 "$out" 2>/dev/null)"; return 1; }
  python3 -c 'import json,sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
print(data.get("id", "") if isinstance(data, dict) else "")' "$out" 2>/dev/null
}

build_prompt_request() { # $1 out-file $2 target-file $3 slowhang-token
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
out, target, token = sys.argv[1], sys.argv[2], sys.argv[3]
text = (
    "Use the write tool to create the file %s with the exact content COMMITTED-SUCCESS "
    "(you must use the write tool, not bash). %s "
    "After the write tool succeeds reply with the single word DONE." % (target, token)
)
with open(out, "w", encoding="utf-8") as f:
    json.dump({
        "model": {"providerID": "opencode", "modelID": "e2e-offline"},
        "parts": [{"type": "text", "text": text}],
    }, f)
PY
}

snapshot() { # $1 sid $2 prefix $3 marker -> writes $LOGS/$2-snap.json/.env
  curl -sS --max-time 15 "$BASE/session/$1/message" -H "Authorization: $AUTH" \
    -o "$LOGS/$2-snap.json" 2>/dev/null || true
  python3 "$RUN/parse_snapshot.py" "$LOGS/$2-snap.json" "$3" > "$LOGS/$2-snap.env" 2>/dev/null || true
}

wait_midstream() { # $1 sid $2 tag $3 prefix -> 0 once the tool-call is streaming
  local deadline parseok toolparts hits
  deadline=$((SECONDS + 90))
  while :; do
    snapshot "$1" "$3" "[SLOWHANG:$2]"
    parseok=$(getval_from "$LOGS/$3-snap.env" PARSEOK)
    toolparts=$(getval_from "$LOGS/$3-snap.env" TOOLPARTS)
    case "$toolparts" in ''|*[!0-9]*) toolparts=0 ;; esac
    hits=$(llm_hits "$2")
    if [ "$parseok" = "1" ] && [ "$toolparts" -ge 1 ] && [ "$hits" -ge 1 ]; then
      return 0
    fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# 3. Leg A - cancel mid-stream (FIN-02 cancel; UI-017 no-retry).
# ---------------------------------------------------------------------------
say "STEP 6/10: leg A - prompt streams slowly, abort mid-stream"
SID_A=$(create_session "v1-cancel-restart-a" "$LOGS/session-a.json") \
  || fail legA-create "could not create session A: $(head -c 300 "$LOGS/session-a.json" 2>/dev/null)"
[ -n "$SID_A" ] || fail legA-create "empty session id in $(head -c 300 "$LOGS/session-a.json" 2>/dev/null)"
build_prompt_request "$LOGS/legA-prompt-request.json" "$WORK/cancel-target.txt" "[SLOWHANG:cancel]" \
  || fail legA-prompt "could not build prompt request"
curl -sS --max-time 300 -o "$LOGS/legA-prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID_A/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/legA-prompt-request.json" \
  > "$LOGS/legA-prompt-http.txt" 2>"$LOGS/legA-prompt.err" &
PROMPT_A_PID=$!
wait_midstream "$SID_A" cancel legA \
  || fail legA-midstream "assistant tool-call never streamed (hits=$(llm_hits cancel))"
say "EVIDENCE legA midstream=true hits=$(llm_hits cancel) toolparts=$(getval_from "$LOGS/legA-snap.env" TOOLPARTS)"

# --- abort mid-stream ------------------------------------------------------
ABORT_STATUS=$(curl -sS --max-time 30 -o "$LOGS/legA-abort.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID_A/abort" -H "Authorization: $AUTH" 2>/dev/null || echo "000")
case "$ABORT_STATUS" in
  2*) ;;
  *) fail legA-abort "abort HTTP $ABORT_STATUS: $(head -c 300 "$LOGS/legA-abort.json" 2>/dev/null)" ;;
esac

# settle: the session must reach idle (cancelled), never stay stuck busy.
settle_deadline=$((SECONDS + 60))
st="busy"
while :; do
  st=$(session_status "$SID_A")
  [ "$st" != "busy" ] && break
  [ "$SECONDS" -ge "$settle_deadline" ] && break
  sleep 1
done
expect_eq "$st" "idle" legA-settled

# the blocked prompt POST should return once the turn is settled (bounded).
pa_deadline=$((SECONDS + 60))
while kill -0 "$PROMPT_A_PID" 2>/dev/null && [ "$SECONDS" -lt "$pa_deadline" ]; do sleep 1; done
if kill -0 "$PROMPT_A_PID" 2>/dev/null; then
  kill -TERM "$PROMPT_A_PID" 2>/dev/null || true
fi
wait "$PROMPT_A_PID" 2>/dev/null || true
PROMPT_A_PID=""
PROMPT_A_HTTP=$(cat "$LOGS/legA-prompt-http.txt" 2>/dev/null || echo "none")
say "EVIDENCE legA abort_http=$ABORT_STATUS prompt_http=$PROMPT_A_HTTP settled=idle"

# fail-closed assertions on the settled snapshot
snapshot "$SID_A" legAfinal "[SLOWHANG:cancel]"
expect_eq "$(getval_from "$LOGS/legAfinal-snap.env" PARSEOK)" "1" legA-journal-parse
CLEAN_A=$(getval_from "$LOGS/legAfinal-snap.env" CLEAN_SUCCESS)
expect_eq "$CLEAN_A" "0" legA-no-false-success
ASSIST_A=$(getval_from "$LOGS/legAfinal-snap.env" ASSISTANTCOUNT)
expect_eq "$ASSIST_A" "1" legA-single-assistant
if [ -e "$WORK/cancel-target.txt" ]; then
  fail legA-no-partial-file "write target exists after cancel (content: $(head -c 120 "$WORK/cancel-target.txt" 2>/dev/null))"
fi
say "EVIDENCE legA cancelled_not_done=true error_present=$([ -n "$(getval_from "$LOGS/legAfinal-snap.env" LAST_ERROR)" ] && echo yes || echo no) target_absent=true"

# grace window: no blind automatic retry may re-invoke model or tool.
HITS_A=$(llm_hits cancel)
sleep 12
HITS_A2=$(llm_hits cancel)
expect_eq "$HITS_A2" "$HITS_A" legA-no-retry
if [ -e "$WORK/cancel-target.txt" ]; then
  fail legA-no-retry-write "write target appeared after the grace window"
fi
snapshot "$SID_A" legApost "[SLOWHANG:cancel]"
expect_eq "$(getval_from "$LOGS/legApost-snap.env" ASSISTANTCOUNT)" "1" legA-no-retry-assistant
expect_eq "$(getval_from "$LOGS/legApost-snap.env" CLEAN_SUCCESS)" "0" legA-no-false-success-post
expect_eq "$(llm_hits cancel)" "1" legA-single-llm-request
say "STEP 7/10: leg A PASS (hits_before=$HITS_A hits_after=$HITS_A2 assistant=1 target_absent=true)"

# ---------------------------------------------------------------------------
# 4. Leg B - SIGKILL mid-stream, restart on the SAME state dir (FIN-02/UI-017).
# ---------------------------------------------------------------------------
say "STEP 8/10: leg B - prompt streams slowly, SIGKILL serve mid-stream"
SID_B=$(create_session "v1-cancel-restart-b" "$LOGS/session-b.json") \
  || fail legB-create "could not create session B: $(head -c 300 "$LOGS/session-b.json" 2>/dev/null)"
[ -n "$SID_B" ] || fail legB-create "empty session id in $(head -c 300 "$LOGS/session-b.json" 2>/dev/null)"
build_prompt_request "$LOGS/legB-prompt-request.json" "$WORK/kill-target.txt" "[SLOWHANG:kill]" \
  || fail legB-prompt "could not build prompt request"
curl -sS --max-time 300 -o "$LOGS/legB-prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID_B/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/legB-prompt-request.json" \
  > "$LOGS/legB-prompt-http.txt" 2>"$LOGS/legB-prompt.err" &
PROMPT_B_PID=$!
wait_midstream "$SID_B" kill legB \
  || fail legB-midstream "assistant tool-call never streamed (hits=$(llm_hits kill))"

snapshot "$SID_B" legBpre "[SLOWHANG:kill]"
expect_eq "$(getval_from "$LOGS/legBpre-snap.env" PARSEOK)" "1" legB-pre-snapshot-parse
ASSIST_B_PRE=$(getval_from "$LOGS/legBpre-snap.env" ASSISTANTCOUNT)
USER_B_PRE=$(getval_from "$LOGS/legBpre-snap.env" USERMARKERCOUNT)
HITS_B_PRE=$(llm_hits kill)
expect_eq "$USER_B_PRE" "1" legB-pre-user-single
expect_eq "$ASSIST_B_PRE" "1" legB-pre-assistant-single
say "EVIDENCE legB midstream=true hits_pre=$HITS_B_PRE toolparts=$(getval_from "$LOGS/legBpre-snap.env" TOOLPARTS)"

# --- SIGKILL the server mid-stream (no graceful shutdown) ------------------
OLD_SERVER_PID="$SERVER_PID"
pkill -KILL -P "$OLD_SERVER_PID" 2>/dev/null || true
kill -KILL "$OLD_SERVER_PID" 2>/dev/null || true
kill_deadline=$((SECONDS + 20))
while kill -0 "$OLD_SERVER_PID" 2>/dev/null && [ "$SECONDS" -lt "$kill_deadline" ]; do sleep 0.5; done
if kill -0 "$OLD_SERVER_PID" 2>/dev/null; then
  fail legB-kill "server survived SIGKILL (pid=$OLD_SERVER_PID)"
fi
SERVER_PID=""
kb_deadline=$((SECONDS + 30))
while kill -0 "$PROMPT_B_PID" 2>/dev/null && [ "$SECONDS" -lt "$kb_deadline" ]; do sleep 1; done
kill -TERM "$PROMPT_B_PID" 2>/dev/null || true
wait "$PROMPT_B_PID" 2>/dev/null || true
PROMPT_B_PID=""
PROMPT_B_HTTP=$(cat "$LOGS/legB-prompt-http.txt" 2>/dev/null || echo "none")
say "EVIDENCE legB sigkill=true old_pid=$OLD_SERVER_PID prompt_http=$PROMPT_B_HTTP"

# --- restart serve against the SAME HOME/XDG state dirs -------------------
say "STEP 9/10: leg B - restart serve on the same state dir, verify recovery"
boot_server restart
say "EVIDENCE legB restart=healthy old_base=$FIRST_BASE new_base=$BASE same_state_dir=$XDG_DATA_HOME"

# the SIGKILLed server must stay dead (no zombie twin serving stale state)
if kill -0 "$OLD_SERVER_PID" 2>/dev/null; then
  fail legB-old-server-dead "SIGKILLed server came back to life (pid=$OLD_SERVER_PID)"
fi

# session must still exist after restart
sg=$(curl -sS --max-time 15 -o "$LOGS/legB-session.json" -w '%{http_code}' \
  "$BASE/session/$SID_B" -H "Authorization: $AUTH" 2>/dev/null || echo "000")
expect_eq "$sg" "200" legB-session-persisted

# journal consistency + duplicate detectors on the replayed messages
curl -sS --max-time 15 "$BASE/session/$SID_B/message" -H "Authorization: $AUTH" \
  -o "$LOGS/legB-post.json" 2>/dev/null || true
python3 "$RUN/parse_snapshot.py" "$LOGS/legB-post.json" "[SLOWHANG:kill]" > "$LOGS/legB-post.env" 2>/dev/null || true
getb() { getval_from "$LOGS/legB-post.env" "$1"; }
expect_eq "$(getb PARSEOK)" "1" legB-journal-parse "messages did not parse after restart: $(head -c 200 "$LOGS/legB-post.json" 2>/dev/null)"
expect_eq "$(getb DUP_MSG_IDS)" "0" legB-no-duplicate-messages
expect_eq "$(getb DUP_PART_IDS)" "0" legB-no-duplicate-parts
expect_eq "$(getb USERMARKERCOUNT)" "1" legB-user-not-duplicated
expect_eq "$(getb ASSISTANTCOUNT)" "$ASSIST_B_PRE" legB-assistant-not-duplicated
expect_eq "$(getb CLEAN_SUCCESS)" "0" legB-no-false-success
expect_eq "$(getb COST_NONZERO)" "0" legB-cost-zero

# no NEW assistant ids may appear after the restart (replay detector)
if ! python3 - "$LOGS/legBpre-snap.env" "$LOGS/legB-post.env" <<'PY'
import sys
def ids(path):
    for line in open(path, encoding="utf-8"):
        if line.startswith("ASSIST_IDS="):
            return set(x for x in line.strip().split("=", 1)[1].split(",") if x)
    return set()
new = ids(sys.argv[2]) - ids(sys.argv[1])
if new:
    print("NEW_ASSIST_IDS=" + ",".join(sorted(new)))
sys.exit(1 if new else 0)
PY
then
  fail legB-no-replay "restart created NEW assistant message ids: $(grep '^ASSIST_IDS=' "$LOGS/legB-post.env" 2>/dev/null)"
fi

# no automatic re-prompt of the interrupted turn after restart
expect_eq "$(llm_hits kill)" "$HITS_B_PRE" legB-no-replay-llm

# no committed partial write survived the crash
if [ -e "$WORK/kill-target.txt" ]; then
  fail legB-no-committed-partial "write target exists after crash+restart (content: $(head -c 120 "$WORK/kill-target.txt" 2>/dev/null))"
fi

# the session must settle idle and STAY idle (no spontaneous replay activity)
st=$(session_status "$SID_B")
expect_eq "$st" "idle" legB-status-idle
sleep 6
st2=$(session_status "$SID_B")
expect_eq "$st2" "idle" legB-status-stays-idle
expect_eq "$(llm_hits kill)" "$HITS_B_PRE" legB-no-deferred-replay
say "STEP 10/10: leg B PASS (dups=0 replay=0 hits_pre=$HITS_B_PRE hits_post=$(llm_hits kill) status=idle)"

# ---------------------------------------------------------------------------
# 5. Global fail-closed sweep + PASS marker
# ---------------------------------------------------------------------------
expect_eq "$(getval_from "$LOGS/legApost-snap.env" COST_NONZERO)" "0" global-cost-zero-a
expect_eq "$(getb COST_NONZERO)" "0" global-cost-zero-b
expect_eq "$(llm_hits cancel)" "1" global-single-request-cancel
expect_eq "$(llm_hits kill)" "1" global-single-request-kill

# no corrupt JSON anywhere opencode persisted state under the shared data dir
if ! python3 - "$XDG_DATA_HOME" <<'PY'
import json, os, sys
bad = []
checked = 0
for root, _dirs, files in os.walk(sys.argv[1]):
    for name in files:
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        checked += 1
        try:
            json.load(open(path, encoding="utf-8"))
        except Exception as exc:
            bad.append("%s: %s" % (path, exc))
print("JSONCHECK checked=%d corrupt=%d" % (checked, len(bad)))
for row in bad[:10]:
    print("CORRUPT " + row)
sys.exit(1 if bad else 0)
PY
then
  fail global-journal-integrity "corrupt JSON state files under $XDG_DATA_HOME after crash+restart"
fi

say "E2E_V1_CANCEL_RESTART=PASS"
say "EVIDENCE offline=true network=none provider=opencode/e2e-offline anonymous=true cost=0 mock=$MOCK_BASE catalog=$EVIDENCE_CATALOG profile=user.e2e@1"
say "EVIDENCE cancel: abort_http=$ABORT_STATUS settled=idle clean_success=0 target_absent=true hits=1 retries=0 assistant=1"
say "EVIDENCE restart: sigkill=true restart=healthy same_state_dir=true dup_msg_ids=0 dup_part_ids=0 replayed_assistants=0 llm_replays=0 clean_success=0 cost=0 journal_intact=true"
say "EVIDENCE old_server_dead=true prompt_http_cancel=$PROMPT_A_HTTP prompt_http_kill=$PROMPT_B_HTTP"
say "LOGS=$LOGS"
exit 0
