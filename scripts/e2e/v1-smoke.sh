#!/usr/bin/env bash
# HorizonCode V1 repeatable smoke test (SA-6).
#
# One command, repo-local only, fail-closed. Boots `horizoncode serve` on
# 127.0.0.1 with a random high port and HTTP Basic auth, then:
#   1. negative probe: an unauthenticated POST must be rejected (401) and must
#      not create the scratch file;
#   2. creates a session and sends ONE prompt that instructs the model to use
#      the write tool to create the per-run scratch file
#      .tmp/e2e/ok-$RUN_ID.txt containing exactly `OK`;
#   3. asserts the assistant message has no `error`, the file content is exact,
#      the write tool completed, and the reported cost is 0.
#
# All HOME/XDG/TMPDIR state lives under .tmp/e2e; only .tmp/e2e/logs survive a
# run. The mock LLM and the server are always killed via trap.
# Non-zero exit on any failed assertion. Fully offline/zero-egress: a local
# loopback Python mock serves the pinned opencode/e2e-offline model (cost 0,
# endpoint 127.0.0.1); the real HostKernel/Guard gates run; no remote endpoint
# is ever contacted. Provider credential env vars are scrubbed from serve.
#
# Run-ID isolation: each invocation derives RUN_ID (timestamp + PID) and writes
# its evidence to .tmp/e2e/logs/v1-smoke-$RUN_ID/ plus .tmp/e2e/ok-$RUN_ID.txt,
# so a repeat or concurrent run never overwrites a prior run's logs, and a
# stale/parallel ok-file can never satisfy this run's assertions.
# NOTE: `logs/v1-smoke-*` dirs ACCUMULATE on purpose (prior-run evidence is
# never auto-deleted). Reclaim space manually when no run is active, e.g.
#   rm -rf .tmp/e2e/logs/v1-smoke-*
#
# Usage:
#   bash scripts/e2e/v1-smoke.sh
#   OPENCODE_SERVER_PASSWORD=... bash scripts/e2e/v1-smoke.sh   # optional pin
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/.tmp/e2e"
# Unique per-run identity (timestamp + PID): isolates this run's logs and
# ok-file from every prior/concurrent run (see header note). Prior runs'
# logs/v1-smoke-* dirs are left in place; clean them manually when idle.
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
# Per-run STATE dir (config/tmp/mock/wrapper) so parallel/repeated runs never
# clobber each other's scratch. The name must stay SHORT: the HostKernel Unix
# socket lives at $RUN/state/opencode/hz-kernel/host-<16>.sock and must be
# <108 bytes (repo root costs 33). md5(RUN_ID) first 8 -> "sm-XXXXXXXX"
# (11 chars) keeps that socket at 106 bytes while staying unique per run.
# The session observer is NOT started here (no OPENCODE_SESSION_OBSERVER_MANIFEST),
# so the HostKernel socket is the only Unix socket this run creates.
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum 2>/dev/null | cut -c1-8)"
# Fail closed rather than silently sharing one state dir when md5sum is absent.
if ! printf '%s' "$RUN_TAG" | grep -Eq '^[0-9a-f]{8}$'; then
  printf 'E2E_V1_SMOKE=FAIL\nEVIDENCE_FAIL step=env detail=could not derive a valid 8-hex run tag from RUN_ID (md5sum unavailable?)\n' >&2
  exit 1
fi
RUN="$E2E/sm-$RUN_TAG"
# Fail closed if the derived run dir would push the HostKernel socket to >=108.
HOST_SOCK="$RUN/state/opencode/hz-kernel/host-0123456789abcdef.sock"
if [ "${#HOST_SOCK}" -ge 108 ]; then
  printf 'E2E_V1_SMOKE=FAIL\nEVIDENCE_FAIL step=env detail=HostKernel socket path is %s bytes (>=108); run dir name too long: %s\n' "${#HOST_SOCK}" "$RUN" >&2
  exit 1
fi
LOGS="$E2E/logs/v1-smoke-$RUN_ID"
# The guarded-write journey runs against a small, clean project directory rather
# than the checkout itself: the revision walker bounds a workspace and this
# monorepo vendors hundreds of thousands of files outside dependency trees.
PROJECT="$RUN/work"
OK_FILE="$PROJECT/ok-$RUN_ID.txt"

ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$RUN/state"
export PATH="$ORIG_HOME/.bun/bin:$PATH"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-v1-smoke-$RANDOM-$RANDOM}"

# Exclusive creation: a tag collision must fail this run rather than share state
# with a live one. Directories only; no file is removed or overwritten here.
if ! mkdir "$RUN" 2>/dev/null; then
  printf 'E2E_V1_SMOKE=FAIL\nEVIDENCE_FAIL step=env detail=run dir already exists (tag collision or stale run): %s\n' "$RUN" >&2
  exit 1
fi
mkdir -p "$RUN"/config "$RUN"/data "$RUN"/state "$RUN"/cache "$RUN"/home "$RUN"/tmp "$RUN"/work "$LOGS" || {
  printf 'E2E_V1_SMOKE=FAIL\nEVIDENCE_FAIL step=env detail=could not create per-run scratch tree under %s\n' "$RUN" >&2
  exit 1
}

BUN="${BUN:-}"
if [ -z "$BUN" ]; then
  BUN="$(command -v bun 2>/dev/null || true)"
fi
if [ -z "$BUN" ] && [ -x "$ORIG_HOME/.bun/bin/bun" ]; then BUN="$ORIG_HOME/.bun/bin/bun"; fi

SERVER_PID=""
APPROVER_PID=""
MOCK_PID=""
BASE=""
EVIDENCE_CATALOG=""

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
  if [ -n "$APPROVER_PID" ] && kill -0 "$APPROVER_PID" 2>/dev/null; then
    kill -TERM "$APPROVER_PID" 2>/dev/null
  fi
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
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$MOCK_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$MOCK_PID" 2>/dev/null || true
  fi
  rm -f "$OK_FILE"
  rm -rf "$RUN"
  cap_logs
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

fail() {
  step=$1
  shift
  say "E2E_V1_SMOKE=FAIL"
  say "EVIDENCE upto=$step unauth=${unauth_status:-none} session=${SID:-none} assistant=${STATE:-none} cost=${COST:-none} write=${WRITE:-none}"
  say "EVIDENCE_FAIL step=$step detail=$(printf '%s' "$*" | cut -c1-600)"
  if [ -s "$LOGS/serve.log" ]; then
    say "--- serve.log tail ---"
    tail -n 15 "$LOGS/serve.log" | cut -c1-400
  fi
  say "LOGS=$LOGS"
  exit 1
}

[ -n "$BUN" ] || fail env "bun not found on PATH or \$HOME/.bun/bin (PATH=$PATH)"
[ "$OPENCODE_SERVER_PASSWORD" != "" ] || fail env "OPENCODE_SERVER_PASSWORD must be non-empty"

# Offline guard: never hit models.dev or any remote endpoint. models fetch and
# autoupdate are disabled; the catalog is an inline loopback-only model built
# below (after the local mock reports its port), so the run is zero-egress.
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_AUTH_CONTENT="{}"

# Primary AgentProfileV2 (Core Config, read from the GLOBAL user config file).
# The smoke prompt pins opencode/e2e-offline; a direct provider pin is only
# authorized when a configured primary profile (main role, Core-Config/user
# source) selects the SAME pinned provider/model. The global opencode.json must
# contain ONLY Core-Current agent-profile keys: any opencode/V1 marker key (for
# example "permission") makes Core isV1() misclassify the file and route it
# through migrate(), which silently DROPS agent_profiles/
# agent_profile_selectors/primary_agent_profile_selector. The isolated tool
# "permission":"allow" policy is therefore carried via OPENCODE_CONFIG_CONTENT
# (opencode config), which Core's V1 detector never parses.
mkdir -p "$XDG_CONFIG_HOME/opencode"
python3 - > "$XDG_CONFIG_HOME/opencode/opencode.json" <<'PY'
import json
profile = {
    "schemaVersion": 2,
    "profileId": "user.primary",
    "revision": "1",
    "name": "V1 Smoke Primary",
    "description": "Primary profile for the V1 smoke journey",
    "source": "user",
    "roles": ["main"],
    "purpose": "Authorize the pinned opencode/e2e-offline direct route",
    "whenToUse": "V1 smoke E2E",
    "whenNotToUse": "Production",
    "adapter": {"kind": "native", "adapterId": "horizon.native"},
    "model": {"providerId": "opencode", "modelId": "e2e-offline"},
    "harness": "native-rich",
    "reasoning": "off",
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
    "limits": {"maxDepth": 2, "maxActiveChildren": 2, "maxTotalChildren": 2, "maxPendingMessages": 8, "maxMessageBytes": 4096},
    "maxParallelChildren": 1,
    "enabled": True,
}
config = {
    "agent_profiles": [profile],
    "agent_profile_selectors": [{"selector": "primary", "profileId": "user.primary", "revision": "1"}],
    "primary_agent_profile_selector": "primary",
}
print(json.dumps(config))
PY
[ -s "$XDG_CONFIG_HOME/opencode/opencode.json" ] || fail env "failed to write global opencode.json with primary AgentProfileV2"
say "CONFIG primary-agent-profile profileId=user.primary@1 model=opencode/e2e-offline harness=native-rich role=main"

# Isolated permission policy, NARROWED to exactly the write tool. The prompt
# legitimately asks for one write inside this repo-local scratch; NO other
# permission is pre-allowed (a broad "allow" would auto-approve non-tool asks
# that the tool-only approve_loop deliberately skips). ConfigPermissionV1 maps
# {key: action} -> ruleset {permission: key}; the write tool is gated by BOTH
# its tool name "write" and capability "files.write" (session/tools.ts
# permissionAction evaluates each, deny > ask > allow), so both are allowed and
# every other permission falls through to the default "ask" (never auto-granted).
# Carried via OPENCODE_CONFIG_CONTENT (NOT the global file) so Core's V1
# detector never misclassifies the agent-profile-only global config above.
python3 - > "$RUN/config-content.json" <<'PY'
import json
print(json.dumps({"permission": {"write": "allow", "files.write": "allow"}}))
PY
[ -s "$RUN/config-content.json" ] || fail env "failed to build OPENCODE_CONFIG_CONTENT"
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT="$(cat "$RUN/config-content.json")"
say "CONFIG permission=narrow(write,files.write)=allow via OPENCODE_CONFIG_CONTENT (global file kept agent-profile-only)"

AUTH="$(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
AUTH="Basic $AUTH"

cat > "$RUN/parse_messages.py" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception as exc:
    print("STATE=badjson")
    print("PARSEERR=%s" % exc)
    sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
if not isinstance(msgs, list):
    msgs = []
assistants = [
    m for m in msgs
    if isinstance(m, dict) and isinstance(m.get("info"), dict) and m["info"].get("role") == "assistant"
]
if not assistants:
    print("STATE=waiting")
    print("MSGCOUNT=%d" % len(msgs))
    sys.exit(0)
info = assistants[-1]["info"]
parts = assistants[-1].get("parts") or []
error = info.get("error")
cost = info.get("cost")
time = info.get("time") if isinstance(info.get("time"), dict) else {}
done = bool(time.get("completed")) or info.get("finish") is not None
write_state = "none"
write_error = ""
# The write runs in its own assistant step and the turn then settles with a final
# text step, so scan every assistant message for the newest write tool part.
for message in assistants:
    for p in (message.get("parts") or []):
        if not isinstance(p, dict) or p.get("type") != "tool":
            continue
        if p.get("tool") not in ("write", "files.write"):
            continue
        st = p.get("state") if isinstance(p.get("state"), dict) else {}
        write_state = st.get("status") or "unknown"
        if st.get("status") == "error":
            write_error = str(st.get("error") or "")[:500]
        else:
            write_error = ""
print("STATE=%s" % ("done" if done else "running"))
print("COST=%s" % ("null" if cost is None else cost))
print("ERROR=%s" % (json.dumps(error) if error else ""))
print("WRITE=%s" % write_state)
print("WRITEERR=%s" % write_error)
print("MSGCOUNT=%d" % len(msgs))
PY

# ---------------------------------------------------------------------------
# 1. Local loopback mock LLM + inline catalog (fully offline; zero egress).
#    The python mock binds 127.0.0.1 only and scripts the ONE smoke turn: it
#    emits a write tool-call creating the exact per-run OK file, then on the
#    tool-result turn finishes the assistant. The inline catalog registers
#    opencode/e2e-offline (cost 0) against that loopback endpoint, so provider
#    traffic never leaves 127.0.0.1. models.dev is never contacted
#    (OPENCODE_DISABLE_MODELS_FETCH=1, no `models --refresh`).
# ---------------------------------------------------------------------------
cat > "$RUN/mock-llm.py" <<'PYMOCK'
#!/usr/bin/env python3
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = sys.argv[1]
OK_FILE = sys.argv[2]
LOG_LOCK = threading.Lock()

def log_event(mode, path):
    row = {"t": time.time(), "mode": mode, "path": path}
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
        "model": "e2e-offline",
        "choices": [{"index": 0, "delta": delta}],
    }
    if finish:
        c["choices"][0]["finish_reason"] = finish
    return ("data: " + json.dumps(c) + "\n\n").encode()

def usage_chunk(usage):
    return ("data: " + json.dumps({
        "id": "chatcmpl-e2e",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "e2e-offline",
        "choices": [],
        "usage": usage,
    }) + "\n\n").encode()

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
            self._json({"object": "list", "data": [{"id": "e2e-offline", "object": "model"}]})
            return
        self._json({"ok": True, "service": "e2e-mock-llm"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        body = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}
        msgs = payload.get("messages") if isinstance(payload, dict) else None
        msgs = msgs if isinstance(msgs, list) else []
        if "Generate a title for this conversation" in body:
            log_event("title", self.path)
            self._send_text("E2E Title")
            return
        has_tool_turn = any(
            isinstance(m, dict) and (m.get("role") == "tool" or m.get("tool_calls"))
            for m in msgs
        )
        if has_tool_turn:
            log_event("final", self.path)
            self._send_final()
            return
        if OK_FILE in body:
            log_event("write_call", self.path)
            self._send_write_call()
            return
        log_event("text", self.path)
        self._send_text("ok")

    def _send_text(self, value):
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

    def _send_write_call(self):
        args = json.dumps({"filePath": OK_FILE, "content": "OK"})
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({
                "tool_calls": [{
                    "index": 0,
                    "id": "call_e2e_write",
                    "type": "function",
                    "function": {"name": "write", "arguments": args},
                }],
            }))
            self.wfile.write(chunk({}, finish="tool_calls"))
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _send_final(self):
        usage = {
            "prompt_tokens": 12,
            "completion_tokens": 3,
            "total_tokens": 15,
            "prompt_tokens_details": {"cached_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0},
        }
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({"content": "DONE"}))
            self.wfile.write(chunk({}, finish="stop"))
            self.wfile.write(usage_chunk(usage))
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
srv.daemon_threads = True
print("MOCK_READY port=%d" % srv.server_address[1], flush=True)
srv.serve_forever()
PYMOCK
[ -s "$RUN/mock-llm.py" ] || fail mock-llm "failed to write the offline mock LLM"
MOCK_LOG="$LOGS/llm-hits.jsonl"
: > "$MOCK_LOG"
python3 "$RUN/mock-llm.py" "$MOCK_LOG" "$OK_FILE" > "$LOGS/mock.out" 2>&1 &
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
case "$mock_probe" in *e2e-mock-llm*) ;; *) fail mock-llm "mock health probe failed: $mock_probe" ;; esac
say "STEP mock: loopback mock LLM up on $MOCK_BASE (pid=$MOCK_PID)"

# Inline loopback catalog: register opencode/e2e-offline against the mock.
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
say "CATALOG: inline opencode/e2e-offline api=$MOCK_BASE/v1 cost=0 (models fetch disabled; no models.dev hit)"

# ---------------------------------------------------------------------------
# 1b. HostKernel binary: the direct provider-authority gate requires the real
#     HostKernel's permission-mode snapshot, which only exists when the
#     compiled binary's embedded kernel is present. A source-mode `bun run`
#     has no build-time defines (see packages/horizoncode/script/build.ts), so
#     the repo-local hz-kernel binary is injected as build globals through an
#     entry wrapper (a plain `--preload` is ignored here because
#     packages/horizoncode/bunfig.toml pins its own preload list). The wrapper sets
#     the exact build manifest shape then imports the CLI entry, so the REAL
#     kernel runs; no gate is mocked or weakened. If no kernel binary exists, fail closed.
# ---------------------------------------------------------------------------
# Canonical kernel ONLY: the unverified fallback (any .tmp / target-p2
# hz-kernel-* >50MB trusted by its self-computed SHA) is removed. The manifest
# sha256 below is derived from THIS canonical binary, so a stray file can never
# be substituted. Fail closed if the canonical path is missing.
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
if [ ! -f "$KERNEL_BIN" ]; then
  fail host-kernel "canonical repo-local hz-kernel binary missing: $KERNEL_BIN (unverified .tmp/target-p2 fallback removed); direct turns require the real HostKernel"
fi
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" 2>/dev/null | cut -d' ' -f1)"
case "$KERNEL_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) fail host-kernel "could not sha256sum kernel binary $KERNEL_BIN" ;;
esac
python3 - "$RUN/kernel-wrapper.ts" "$KERNEL_BIN" "$KERNEL_SHA" "$ROOT/packages/horizoncode/src/index.ts" "$PROJECT" <<'PY'
import json, sys
out, asset, sha, entry, project = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
with open(out, "w", encoding="utf-8") as f:
    f.write("// E2E source-mode wrapper: set the build-time defines the compiled binary\n")
    f.write("// embeds (script/build.ts) as globals BEFORE loading the real CLI entry.\n")
    f.write("// A plain `--preload` is ignored here because packages/horizoncode/bunfig.toml\n")
    f.write("// pins its own preload list; setting globals in the entry wrapper sidesteps\n")
    f.write("// that and still runs the REAL HostKernel permission-mode gate.\n")
    f.write("globalThis.OPENCODE_HOST_KERNEL_MANIFEST = JSON.stringify({\n")
    f.write("  schemaVersion: 1,\n")
    f.write('  status: "available",\n')
    f.write('  binaryName: "hz-kernel",\n')
    f.write('  target: "linux-" + process.arch + "-gnu",\n')
    f.write("  sha256: %s,\n" % json.dumps(sha))
    f.write("})\n")
    f.write("globalThis.OPENCODE_HOST_KERNEL_ASSET = %s\n" % json.dumps(asset))
    # `bun run --cwd packages/horizoncode` is only a module-resolution trick; the
    # project the server serves must stay the checkout root, or every write to a
    # repository-root path is correctly refused as outside the workspace.
    f.write("process.chdir(%s)\n" % json.dumps(project))
    f.write("await import(%s)\n" % json.dumps(entry))
PY
[ -s "$RUN/kernel-wrapper.ts" ] || fail host-kernel "failed to write the kernel entry wrapper"
say "EVIDENCE host_kernel=$KERNEL_BIN sha256=$KERNEL_SHA wrapper=kernel-wrapper.ts"
# ---------------------------------------------------------------------------
# 1c. Serve-child env scrub: strip EVERY credential env var declared in the
#     models fixture (safety audit: 156 names) plus the direct-free opt-in and
#     the OTLP headers flag, then a dynamic sweep of any ambient API_KEY /
#     TOKEN / SECRET / CREDENTIAL / PASSWORD name. OPENCODE_SERVER_PASSWORD is
#     kept (it is this run's Basic-auth secret, not provider material).
# ---------------------------------------------------------------------------
python3 - "$ROOT/packages/horizoncode/test/tool/fixtures/models-api.json" > "$RUN/fixture-env.txt" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
names = set()
for prov in d.values():
    if isinstance(prov, dict):
        for e in (prov.get("env") or []):
            if isinstance(e, str):
                names.add(e)
for n in sorted(names):
    print(n)
PY
[ -s "$RUN/fixture-env.txt" ] || fail env "could not extract credential env names from the models fixture"
mapfile -t FIXTURE_ENV < "$RUN/fixture-env.txt"
PROVIDER_SCRUB=()
for scrub_name in "${FIXTURE_ENV[@]}"; do PROVIDER_SCRUB+=(-u "$scrub_name"); done
for scrub_name in HORIZON_DIRECT_FREE_CREDENTIALS OTEL_EXPORTER_OTLP_HEADERS; do PROVIDER_SCRUB+=(-u "$scrub_name"); done
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
say "ENV scrub fixture_names=${#FIXTURE_ENV[@]} flags=${#PROVIDER_SCRUB[@]}"
# ---------------------------------------------------------------------------
# 2. Boot server on a random high loopback port; bounded health retry.
# ---------------------------------------------------------------------------
start_server() {
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
  BASE="http://127.0.0.1:$port"
  : > "$LOGS/serve.log"
  ( cd "$ROOT" && exec env \
      "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
      "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" serve --hostname 127.0.0.1 --port "$port" ) \
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

attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  if start_server; then
    break
  fi
  say "SERVER: attempt $attempt failed; retrying"; tail -c 400 "$LOGS/serve.log" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
done
[ -n "$SERVER_PID" ] || fail server "server did not become healthy after 3 attempts"
if ! kill -0 "$SERVER_PID" 2>/dev/null; then fail server "server exited during health wait"; fi

# Background permission auto-approver: a pending permission ask must never hang
# the non-interactive run. Only TOOL permission requests (PermissionV1.Request
# carrying a `tool` block) are auto-approved; non-tool requests are left
# untouched and nothing is broadened beyond the isolated config above.
approve_loop() {
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    body=$(curl -sS --max-time 3 "$BASE/permission" -H "Authorization: $AUTH" 2>/dev/null || true)
    ids=$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
# Only TOOL permission requests carry a `tool` block (PermissionV1.Request).
# Reply to those alone; leave any non-tool request untouched.
for row in data if isinstance(data, list) else []:
    if isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("tool"), dict):
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
# 3. Negative probe: unauthenticated POST must be 401 and create nothing.
# ---------------------------------------------------------------------------
[ -e "$OK_FILE" ] && rm -f "$OK_FILE"
unauth_status=$(curl -sS --max-time 10 -o "$LOGS/unauth.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H 'content-type: application/json' -d '{}' 2>/dev/null || echo "000")
[ "$unauth_status" = "401" ] || fail auth-negative "expected HTTP 401 without credentials, got $unauth_status"
if [ -e "$OK_FILE" ]; then fail auth-negative "unauthenticated request created $OK_FILE"; fi

# ---------------------------------------------------------------------------
# 4. Create session (authenticated) and send one bounded prompt.
# ---------------------------------------------------------------------------
create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d '{"title":"v1-smoke"}' 2>/dev/null || echo "000")
[ "$create_status" = "200" ] || fail session-create "HTTP $create_status: $(head -c 300 "$LOGS/session.json" 2>/dev/null)"
SID=$(python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
print(data.get("id", "") if isinstance(data, dict) else "")
' "$LOGS/session.json" 2>/dev/null || true)
[ -n "$SID" ] || fail session-create "no session id in response: $(head -c 300 "$LOGS/session.json" 2>/dev/null)"

python3 - "$OK_FILE" > "$LOGS/prompt-request.json" <<'PY'
import json
import sys

path = sys.argv[1]
text = (
    "Use the write tool to create the file %s with the exact content OK "
    "(two characters, no trailing newline). You must use the write tool, not bash. "
    "After the tool succeeds, reply with the single word DONE." % path
)
print(json.dumps({
    "model": {"providerID": "opencode", "modelID": "e2e-offline"},
    "parts": [{"type": "text", "text": text}],
}))
PY

prompt_status=$(curl -sS --max-time 240 -o "$LOGS/prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/prompt-request.json" 2>/dev/null || echo "000")
if [ "$prompt_status" != "200" ]; then
  fail prompt-http "HTTP $prompt_status: $(head -c 500 "$LOGS/prompt-response.json" 2>/dev/null)"
fi

# The prompt call returns after the turn; poll briefly for a settled assistant
# message in case the returned payload is the user message.
deadline=$((SECONDS + 90))
while :; do
  curl -sS --max-time 10 "$BASE/session/$SID/message?limit=50" \
    -H "Authorization: $AUTH" -o "$LOGS/messages.json" 2>/dev/null || true
  python3 "$RUN/parse_messages.py" "$LOGS/messages.json" > "$LOGS/assistant.env" 2>/dev/null || true
  state=$(grep '^STATE=' "$LOGS/assistant.env" 2>/dev/null | cut -d= -f2- || true)
  [ "$state" = "done" ] && break
  [ "$state" = "badjson" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 2
done

getval() { grep "^$1=" "$LOGS/assistant.env" 2>/dev/null | head -n1 | cut -d= -f2- || true; }
STATE=$(getval STATE)
COST=$(getval COST)
ERROR=$(getval ERROR)
WRITE=$(getval WRITE)
WRITEERR=$(getval WRITEERR)

[ "$STATE" = "done" ] || fail assistant "no settled assistant message (state=${STATE:-none})"
[ -z "$ERROR" ] || fail assistant "assistant error present: $ERROR"
[ "$COST" = "0" ] || fail cost "expected reported cost 0, got ${COST:-missing}"

if [ ! -f "$OK_FILE" ]; then
  fail file "write tool did not create $OK_FILE (write_status=${WRITE:-none} write_error=${WRITEERR:-none})"
fi
bytes=$(stat -c%s "$OK_FILE" 2>/dev/null || echo "?")
content=$(cat "$OK_FILE" 2>/dev/null || true)
[ "$bytes" = "2" ] || fail file "expected 2 bytes, got $bytes"
[ "$content" = "OK" ] || fail file "expected content OK, got: $content"
[ "$WRITE" = "completed" ] || fail write "write tool state=$WRITE (error=${WRITEERR:-none})"

say "E2E_V1_SMOKE=PASS"
say "EVIDENCE health=ok base=$BASE"
say "EVIDENCE auth_negative=$unauth_status no_file_created=true"
say "EVIDENCE session=$SID model=opencode/e2e-offline mock=$MOCK_BASE catalog=$EVIDENCE_CATALOG zero_egress=true"
say "EVIDENCE assistant_error=none cost=0 write=$WRITE"
say "EVIDENCE file=.tmp/e2e/ok-$RUN_ID.txt content=OK bytes=$bytes"
say "LOGS=$LOGS"
exit 0
