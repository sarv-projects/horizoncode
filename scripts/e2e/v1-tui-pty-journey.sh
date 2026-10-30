#!/usr/bin/env bash
# scripts/e2e/v1-tui-pty-journey.sh
#
# HorizonCode V1 LIVE interactive TUI PTY journey.
#
# Boots the REAL interactive TUI inside a detached tmux session - a real
# terminal emulator that interprets the TUI's ANSI output - drives it with
# keystrokes, and asserts on the captured pane. This complements
# scripts/e2e/v1-smoke.sh (HTTP/API level) and
# scripts/verify/v1-terminal-e2e.sh (Rust supervisor approval journeys): here
# the assertion surface is the rendered screen a user actually sees.
#
# Architecture (both halves real):
#   * a loopback `horizoncode serve` process carrying the REAL canonical
#     HostKernel (kernel/target/debug/hz-kernel, injected through an entry
#     wrapper because source mode has no build-time defines), so Guard
#     approvals and guarded writes are admitted by the real Rust authority;
#   * the REAL TUI started with `horizoncode attach <loopback url>` in tmux.
#     The TUI renders the server's events and sends the user's decisions back
#     over HTTP, exactly like a networked session.
# Provider traffic goes to a local loopback mock only (opencode/e2e-offline,
# cost 0): no remote endpoint, no paid call, models.dev/autoupdate disabled,
# provider credential env vars unset.
#
# Journey (one continuous interactive session):
#   1. boot      - the TUI renders its welcome screen and prompt input box.
#   2. stream    - a prompt is submitted; assistant tokens render while the
#                  response is still being generated (first token visible
#                  BEFORE the last one), then the response completes.
#   3. permissions - `/permissions` renders the Direct Session permission
#                  matrix: sandbox and approval are independent dimensions and
#                  both must be on screen; Escape then dismisses the dialog.
#   4. write     - a prompt makes the model request an in-workspace write. The
#                  default posture (approval=on-request, sandbox=workspace-write)
#                  admits routine in-workspace work quietly (DEC-V1-28 prepared
#                  lease), so the assertion is the exact bytes on disk plus the
#                  assistant's completion text - never a dialog. An approval
#                  dialog that does appear is answered with the allow key as a
#                  bonus path; its absence is not a failure.
#   5. quit      - the TUI exits cleanly (exit code 0) after Ctrl-C.
#
# Isolation: a unique tmux socket (`-L`) means the user's real tmux server and
# sessions are never touched. All HOME/XDG/TMPDIR state lives under
# .tmp/tui-pty/<run-tag>; the run dir is removed on every non-`--keep` exit,
# and the tmux server, mock process and loopback server are killed by the EXIT
# trap on every path.
#
# Bounded waits: every screen assertion polls `tmux capture-pane` with a
# deadline (0.25s poll) and the write assertion polls the filesystem the same
# way; the only sleep longer than 1s is the final settle. `--keep`
# leaves the tmux session alive for inspection and prints the attach command.
#
# Exit: 0 only when every assertion passes; non-zero with a pane/log dump on
# any failure. Marker lines: `PASS` / `FAIL` plus
# `E2E_V1_TUI_PTY_JOURNEY=PASS|FAIL`.
#
# Usage:
#   bash scripts/e2e/v1-tui-pty-journey.sh
#   bash scripts/e2e/v1-tui-pty-journey.sh --keep      # leave session for debugging
#   bash scripts/e2e/v1-tui-pty-journey.sh --preflight # bundle-check the TUI worker first
#
# Env:
#   BUN=/path/to/bun        Bun binary (default: repo-pinned .tmp Bun, else PATH)
#   TUI_PTY_BIN=/path       optional prebuilt CLI instead of the source entry
#   TUI_PTY_BOOT_TIMEOUT=N  seconds allowed for the first screen (default 150)
#   TUI_PTY_TIMEOUT=N       seconds allowed for each later assertion (default 120)
#   TUI_PTY_SERVER_TIMEOUT=N seconds allowed for the loopback server to become healthy (default 240)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Terminal containment needs a delegated, user-owned cgroup-v2 subtree.
# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"
JDIR="$ROOT/.tmp/tui-pty"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
# Short tag: the HostKernel unix socket lives under RUN and must stay <108 bytes.
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum 2>/dev/null | cut -c1-6)"
case "$RUN_TAG" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *)
    printf 'E2E_V1_TUI_PTY_JOURNEY=FAIL\n'
    printf 'EVIDENCE_FAIL step=env detail=cannot derive a 6-hex run tag (md5sum missing?)\n'
    exit 1
    ;;
esac
RUN="$JDIR/p-$RUN_TAG"
LOGS="$JDIR/logs/v1-tui-pty-journey-$RUN_ID"
PROJECT="$RUN/work"
TARGET_FILE="$PROJECT/pty-journey-write.txt"
EXPECTED_CONTENT="TUI-PTY-JOURNEY-OK"
PANE="$LOGS/pane-latest.txt"
SERVER_LOG="$LOGS/serve.log"
MOCK_LOG="$LOGS/llm-hits.jsonl"

BOOT_TIMEOUT="${TUI_PTY_BOOT_TIMEOUT:-150}"
STEP_TIMEOUT="${TUI_PTY_TIMEOUT:-120}"
SERVER_TIMEOUT="${TUI_PTY_SERVER_TIMEOUT:-240}"
KEEP=0
PREFLIGHT=0

usage() {
  sed -n '2,67p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --preflight) PREFLIGHT=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Environment isolation. Everything both processes write (config, data, cache,
# state, logs) is confined under $RUN. Provider credentials are removed before
# anything is spawned.
# ---------------------------------------------------------------------------
ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$RUN/st"
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_AUTH_CONTENT="{}"
unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENCODE_API_KEY OPENCODE_GO_API_KEY \
  GOOGLE_GENERATIVE_AI_API_KEY DEEPSEEK_API_KEY XAI_API_KEY GROQ_API_KEY COHERE_API_KEY \
  MISTRAL_API_KEY PERPLEXITY_API_KEY 2>/dev/null || true

mkdir -p "$JDIR" 2>/dev/null || true
if ! mkdir "$RUN" 2>/dev/null; then
  printf 'E2E_V1_TUI_PTY_JOURNEY=FAIL\n'
  printf 'EVIDENCE_FAIL step=env detail=run dir already exists (tag collision): %s\n' "$RUN" >&2
  exit 1
fi
mkdir -p "$RUN/home" "$RUN/config/opencode" "$RUN/data" "$RUN/state" "$RUN/cache" \
  "$RUN/tmp" "$PROJECT" "$LOGS" || {
  printf 'E2E_V1_TUI_PTY_JOURNEY=FAIL\n'
  printf 'EVIDENCE_FAIL step=env detail=cannot create per-run scratch tree under %s\n' "$RUN" >&2
  exit 1
}
printf '%s' "$EXPECTED_CONTENT" > "$RUN/expected.txt"

HOST_SOCK="$XDG_STATE_HOME/opencode/hz-kernel/host-0123456789abcdef.sock"
if [ "${#HOST_SOCK}" -ge 108 ]; then
  printf 'E2E_V1_TUI_PTY_JOURNEY=FAIL\n'
  printf 'EVIDENCE_FAIL step=env detail=HostKernel socket path is %s bytes (>=108); run dir too long: %s\n' "${#HOST_SOCK}" "$RUN" >&2
  exit 1
fi

# --- tool preflight --------------------------------------------------------
TMUX_BIN="$(command -v tmux 2>/dev/null || true)"
PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
BUN="${BUN:-}"
if [ -z "$BUN" ]; then
  if [ -x "$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun" ]; then
    BUN="$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  elif [ -x "$ORIG_HOME/.bun/bin/bun" ]; then
    BUN="$ORIG_HOME/.bun/bin/bun"
  fi
fi

SOCK="hztui-pty-$$-${RANDOM}"
SESSION="tui"
MOCK_PID=""
SERVER_PID=""
STATUS=0

dump_diag() {
  if command -v capture >/dev/null 2>&1; then capture || true; fi
  say "--- pane tail (last 30 lines) ---"
  tail -n 30 "$PANE" 2>/dev/null | cut -c1-220 || true
  if [ -s "$SERVER_LOG" ]; then
    say "--- serve.log tail ---"
    tail -n 15 "$SERVER_LOG" | cut -c1-260 || true
  fi
  if [ -s "$MOCK_LOG" ]; then
    say "--- mock llm hits ---"
    tail -n 10 "$MOCK_LOG" | cut -c1-180 || true
  fi
  say "LOGS=$LOGS"
}

fail() {
  step="$1"
  shift
  STATUS=1
  say "E2E_V1_TUI_PTY_JOURNEY=FAIL"
  say "EVIDENCE_FAIL step=$step detail=$(printf '%s' "$*" | cut -c1-700)"
  dump_diag
  exit 1
}

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$KEEP" = "1" ]; then
    capture >/dev/null 2>&1 || true
    cp "$PANE" "$LOGS/pane-final.txt" 2>/dev/null || true
    say "KEEP tmux_socket=$SOCK run=$RUN logs=$LOGS"
    say "KEEP attach: tmux -L $SOCK attach -t $SESSION"
    say "KEEP serve:  kill $SERVER_PID  (log: $SERVER_LOG)"
    exit "$rc"
  fi
  if [ -n "$TMUX_BIN" ]; then
    "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    pkill -TERM -P "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    pkill -KILL -P "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$MOCK_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN"
  if [ "$rc" -eq 0 ]; then
    # A passing run leaves no temp dirs behind; failing runs keep $LOGS for
    # diagnosis (documented in scripts/e2e/README.md).
    rm -rf "$LOGS"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ -n "$TMUX_BIN" ] || fail env "tmux not found on PATH (tmux is the supported real-PTY driver)"
[ -n "$PYTHON_BIN" ] || fail env "python3 not found on PATH"
[ -n "$BUN" ] || fail env "bun not found (set BUN=/path/to/bun; repo pin: .tmp/tools/bun-1.3.14)"
[ -x "$BUN" ] || fail env "BUN is not executable: $BUN"
export PATH="$(dirname "$BUN"):$PATH"
"$BUN" --version >/dev/null 2>&1 || fail env "bun does not run: $BUN"

# ---------------------------------------------------------------------------
# Offline loopback mock LLM. It routes on the LAST user turn only:
#   PTY-STREAM -> token stream with a deliberate pause after the first token
#   PTY-WRITE  -> one write tool call, then "WRITE-STEP COMPLETE" on tool result
# Anything else is logged as unexpected and answered with a marker the journey
# will not find, so a routing bug fails loudly instead of passing quietly.
# ---------------------------------------------------------------------------
cat > "$RUN/mock-llm.py" <<'PYMOCK'
#!/usr/bin/env python3
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = sys.argv[1]
WRITE_TARGET = sys.argv[2]
WRITE_CONTENT = sys.argv[3]
LOCK = threading.Lock()
FIRST_TOKEN_PAUSE = 2.5
CHUNK_GAP = 0.12

def log_event(mode, path):
    try:
        with LOCK:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": time.time(), "mode": mode, "path": path}) + "\n")
    except Exception:
        pass

def chunk(delta, finish=None):
    c = {"id": "chatcmpl-e2e", "object": "chat.completion.chunk", "created": 0,
         "model": "e2e-offline", "choices": [{"index": 0, "delta": delta}]}
    if finish:
        c["choices"][0]["finish_reason"] = finish
    return ("data: " + json.dumps(c) + "\n\n").encode()

def usage_chunk():
    return ("data: " + json.dumps({
        "id": "chatcmpl-e2e", "object": "chat.completion.chunk", "created": 0,
        "model": "e2e-offline", "choices": [],
        "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15,
                  "prompt_tokens_details": {"cached_tokens": 0},
                  "completion_tokens_details": {"reasoning_tokens": 0}},
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
        self._json({"ok": True, "service": "e2e-tui-pty-mock"})

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
            self._text(["TUI PTY Journey"])
            return
        last_user_index = -1
        last_user = ""
        for index in range(len(msgs) - 1, -1, -1):
            message = msgs[index]
            if isinstance(message, dict) and message.get("role") == "user":
                last_user_index = index
                content = message.get("content")
                if isinstance(content, str):
                    last_user = content
                elif isinstance(content, list):
                    last_user = " ".join(
                        x.get("text", "") for x in content if isinstance(x, dict) and isinstance(x.get("text"), str)
                    )
                break
        turn = msgs[last_user_index:] if last_user_index >= 0 else msgs
        has_tool_turn = any(
            isinstance(m, dict) and (m.get("role") == "tool" or m.get("tool_calls")) for m in turn
        )
        if has_tool_turn:
            log_event("final", self.path)
            self._text(["WRITE-STEP COMPLETE"])
            return
        if "PTY-WRITE" in last_user:
            log_event("write_call", self.path)
            self._write_call()
            return
        if "PTY-STREAM" in last_user:
            log_event("stream", self.path)
            self._stream(["STREAM-ALPHA ", "STREAM-BETA ", "STREAM-GAMMA ", "STREAM-DELTA ", "STREAM-OMEGA"])
            return
        log_event("unexpected", self.path)
        self._text(["UNEXPECTED-TURN"])

    def _headers(self):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()

    def _text(self, parts):
        try:
            self._headers()
            self.wfile.write(chunk({"role": "assistant"}))
            for part in parts:
                self.wfile.write(chunk({"content": part}))
            self.wfile.write(chunk({}, finish="stop"))
            self.wfile.write(usage_chunk())
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _stream(self, parts):
        # The first token is delivered alone, then a pause, so a capture can
        # prove the TUI renders tokens while the response is still streaming.
        try:
            self._headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({"content": parts[0]}))
            self.wfile.flush()
            time.sleep(FIRST_TOKEN_PAUSE)
            for part in parts[1:]:
                self.wfile.write(chunk({"content": part}))
                self.wfile.flush()
                time.sleep(CHUNK_GAP)
            self.wfile.write(chunk({}, finish="stop"))
            self.wfile.write(usage_chunk())
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _write_call(self):
        args = json.dumps({"filePath": WRITE_TARGET, "content": WRITE_CONTENT})
        try:
            self._headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({
                "tool_calls": [{
                    "index": 0,
                    "id": "call_pty_write",
                    "type": "function",
                    "function": {"name": "write", "arguments": args},
                }],
            }))
            self.wfile.write(chunk({}, finish="tool_calls"))
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
srv.daemon_threads = True
print("MOCK_READY port=%d" % srv.server_address[1], flush=True)
srv.serve_forever()
PYMOCK
[ -s "$RUN/mock-llm.py" ] || fail mock "failed to write the loopback mock LLM"

: > "$MOCK_LOG"
"$PYTHON_BIN" "$RUN/mock-llm.py" "$MOCK_LOG" "$TARGET_FILE" "$EXPECTED_CONTENT" > "$LOGS/mock.out" 2>&1 &
MOCK_PID=$!
MOCK_PORT=""
for _ in $(seq 1 100); do
  MOCK_PORT="$(sed -n 's/^MOCK_READY port=\([0-9]*\)$/\1/p' "$LOGS/mock.out" 2>/dev/null | head -n1 || true)"
  [ -n "$MOCK_PORT" ] && break
  kill -0 "$MOCK_PID" 2>/dev/null || fail mock "mock LLM exited during startup: $(head -c 400 "$LOGS/mock.out" 2>/dev/null)"
  sleep 0.1
done
[ -n "$MOCK_PORT" ] || fail mock "mock LLM never printed its port: $(head -c 400 "$LOGS/mock.out" 2>/dev/null)"
MOCK_BASE="http://127.0.0.1:$MOCK_PORT"
case "$(curl -sS --max-time 5 "$MOCK_BASE/health" 2>/dev/null || true)" in
  *e2e-tui-pty-mock*) ;;
  *) fail mock "loopback mock health probe failed on $MOCK_BASE" ;;
esac
say "STEP mock: loopback mock LLM on $MOCK_BASE (pid=$MOCK_PID, cost=0, zero egress)"

# Inline loopback-only catalog: opencode/e2e-offline -> the mock. models.dev is
# never contacted (OPENCODE_DISABLE_MODELS_FETCH=1 above).
mkdir -p "$RUN/catalog"
"$PYTHON_BIN" - "$RUN/catalog/models.json" "$MOCK_BASE/v1" <<'PY'
import json, sys
out, api = sys.argv[1], sys.argv[2]
catalog = {"opencode": {"id": "opencode", "name": "OpenCode", "api": api,
    "npm": "@ai-sdk/openai-compatible", "env": [],
    "models": {"e2e-offline": {"id": "e2e-offline", "name": "E2E Offline", "status": "active",
        "family": "e2e", "tool_call": True, "temperature": True, "attachment": False,
        "reasoning": False, "release_date": "2025-01-01",
        "limit": {"context": 100000, "output": 10000},
        "cost": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}}}}}
with open(out, "w", encoding="utf-8") as f:
    json.dump(catalog, f)
PY
[ -s "$RUN/catalog/models.json" ] || fail catalog "failed to write the loopback catalog"
export OPENCODE_MODELS_PATH="$RUN/catalog/models.json"

# Primary AgentProfileV2 (Core Config). The direct provider-authority gate only
# authorizes the pinned opencode/e2e-offline route when a user-source primary
# profile selects the SAME provider/model. The file stays agent-profile-only so
# Core's V1 detector does not migrate (and drop) those keys.
"$PYTHON_BIN" - > "$RUN/config/opencode/opencode.json" <<'PY'
import json
profile = {
    "schemaVersion": 2, "profileId": "user.primary", "revision": "1",
    "name": "V1 TUI PTY Primary", "description": "Primary profile for the V1 TUI PTY journey",
    "source": "user", "roles": ["main"],
    "purpose": "Authorize the pinned opencode/e2e-offline direct route",
    "whenToUse": "V1 TUI PTY E2E", "whenNotToUse": "Production",
    "adapter": {"kind": "native", "adapterId": "horizon.native"},
    "model": {"providerId": "opencode", "modelId": "e2e-offline"},
    "harness": "native-rich", "reasoning": "off", "variants": [],
    "instructions": {"extraRefs": [], "maxCompiledTokens": "4096"},
    "tools": [], "allowedSkillIds": [], "deniedSkillIds": [],
    "allowedMcpServers": [], "allowedMcpToolPatterns": [],
    "allowedSubagentIds": [], "deniedSubagentIds": [], "pathRules": [],
    "context": {"isolation": "fresh", "allowImages": False, "allowDocuments": False, "allowArtifacts": False},
    "inputMode": "default", "memoryPolicy": "none", "isolation": "workspace",
    "lifecycleHooks": [], "capabilityCeiling": [],
    "limits": {"maxDepth": 2, "maxActiveChildren": 2, "maxTotalChildren": 2, "maxPendingMessages": 8, "maxMessageBytes": 4096},
    "maxParallelChildren": 1, "enabled": True,
}
print(json.dumps({
    "agent_profiles": [profile],
    "agent_profile_selectors": [{"selector": "primary", "profileId": "user.primary", "revision": "1"}],
    "primary_agent_profile_selector": "primary",
}))
PY
[ -s "$RUN/config/opencode/opencode.json" ] || fail config "failed to write the primary AgentProfileV2"

# Legacy permission ask, carried via OPENCODE_CONFIG_CONTENT so the global file
# stays profile-only. Under the default direct-session posture a routine
# in-workspace write is admitted by the quiet prepared lease, so this normally
# stays dormant; if it does fire, the journey answers the prompt (bonus path).
export OPENCODE_CONFIG_CONTENT='{"permission":{"write":"ask","files.write":"ask"}}'
say "CONFIG model=opencode/e2e-offline permission=ask(write,files.write) posture_default=on-request+workspace-write profile=user.primary@1"

# Optional fail-fast: a broken TUI import graph hangs the real TUI with a blank
# pane and no error. `attach` does not use the TUI worker, but the server graph
# is the same kind of risk, so this bundles the TUI worker as a smoke check.
if [ "$PREFLIGHT" = "1" ]; then
  say "STEP preflight: bundling the TUI worker graph (fail fast on broken imports)"
  preflight_rc=0
  ( cd "$ROOT/packages/horizoncode" && timeout 420 "$BUN" build ./src/cli/tui/worker.ts \
      --target=bun --outdir "$RUN/preflight" > "$LOGS/preflight.log" 2>&1 ) || preflight_rc=$?
  bad_errors="$(grep -E '^error:' "$LOGS/preflight.log" 2>/dev/null | grep -vE '@opentui/core-(darwin|linux|win32)-' || true)"
  if [ "$preflight_rc" -ne 0 ] || [ -n "$bad_errors" ]; then
    say "EVIDENCE_IMPORT $(printf '%s' "$bad_errors" | head -8 | cut -c1-240)"
    fail preflight "TUI worker graph does not resolve (rc=$preflight_rc); see $LOGS/preflight.log"
  fi
  say "STEP preflight: TUI worker graph resolves"
fi

# ---------------------------------------------------------------------------
# Loopback server with the REAL canonical HostKernel. Source mode has no
# build-time defines (packages/horizoncode/script/build.ts injects them only into
# compiled binaries), so an entry wrapper publishes the manifest globals and
# imports the real CLI; no gate is mocked or weakened. Guarded writes are then
# admitted by the real hz-kernel and land on disk.
# ---------------------------------------------------------------------------
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
[ -f "$KERNEL_BIN" ] || fail host-kernel "canonical hz-kernel binary missing: $KERNEL_BIN (build: cargo build --bin hz-kernel)"
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" 2>/dev/null | cut -d' ' -f1)"
case "$KERNEL_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) fail host-kernel "could not sha256sum the kernel binary: $KERNEL_BIN" ;;
esac
cat > "$RUN/kernel-wrapper.ts" <<WRAP
globalThis.OPENCODE_HOST_KERNEL_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  status: "available",
  binaryName: "hz-kernel",
  target: "linux-" + process.arch + "-gnu",
  sha256: "$KERNEL_SHA",
})
globalThis.OPENCODE_HOST_KERNEL_ASSET = "$KERNEL_BIN"
process.chdir("$PROJECT")
await import("$ROOT/packages/horizoncode/src/index.ts")
WRAP
[ -s "$RUN/kernel-wrapper.ts" ] || fail host-kernel "failed to write the kernel entry wrapper"
say "EVIDENCE host_kernel=$KERNEL_BIN sha256=$KERNEL_SHA"

OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-v1-tui-pty-$RANDOM-$RANDOM}"
export OPENCODE_SERVER_PASSWORD
AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
PORT="$("$PYTHON_BIN" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
[ -n "$PORT" ] || fail server "could not allocate a loopback port"
BASE="http://127.0.0.1:$PORT"
: > "$SERVER_LOG"
( cd "$ROOT" && exec "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" serve --hostname 127.0.0.1 --port "$PORT" ) >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
say "STEP server: horizoncode serve on $BASE (pid=$SERVER_PID, kernel-backed)"
health_deadline=$((SECONDS + SERVER_TIMEOUT))
healthy=0
while [ "$SECONDS" -lt "$health_deadline" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail server "server exited during startup: $(tail -n 5 "$SERVER_LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-500)"
  fi
  if curl -fsS --max-time 2 "$BASE/global/health" -H "Authorization: $AUTH" > "$LOGS/health.json" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 0.25
done
[ "$healthy" = "1" ] || fail server "server never became healthy within ${SERVER_TIMEOUT}s: $(tail -n 8 "$SERVER_LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-600)"
say "STEP server: healthy (auth required, directory=$PROJECT)"

# ---------------------------------------------------------------------------
# PTY: detached tmux on a UNIQUE socket. The session inherits this script's
# already-isolated environment (fresh tmux server) and runs the REAL TUI
# attached to the loopback server, then echoes the exit code and sleeps so the
# pane survives for the final capture.
# ---------------------------------------------------------------------------
"$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true

if [ -n "${TUI_PTY_BIN:-}" ]; then
  [ -x "$TUI_PTY_BIN" ] || fail bin "TUI_PTY_BIN is not executable: $TUI_PTY_BIN"
  LAUNCH="'$TUI_PTY_BIN' attach '$BASE' -p '$OPENCODE_SERVER_PASSWORD' --dir '$PROJECT'"
  say "STEP boot: prebuilt CLI ($TUI_PTY_BIN) attach (stale-build caveat)"
else
  [ -f "$ROOT/packages/horizoncode/src/index.ts" ] || fail bin "source entry missing: packages/horizoncode/src/index.ts"
  LAUNCH="'$BUN' run src/index.ts attach '$BASE' -p '$OPENCODE_SERVER_PASSWORD' --dir '$PROJECT'"
fi

TMUX_CMD="cd '$ROOT/packages/horizoncode' && $LAUNCH; rc=\$?; echo ::TUI_EXIT::\$rc; sleep 600"
"$TMUX_BIN" -L "$SOCK" -f /dev/null new-session -d -s "$SESSION" -x 140 -y 42 -c "$PROJECT" "$TMUX_CMD" || \
  fail pty "tmux could not create the detached session (socket=$SOCK)"
say "STEP pty: tmux socket=$SOCK session=$SESSION size=140x42"
say "STEP boot: TUI attach $BASE (project=$PROJECT)"

# --- screen helpers --------------------------------------------------------
capture() {
  "$TMUX_BIN" -L "$SOCK" capture-pane -p -J -t "$SESSION" > "$PANE" 2>/dev/null || true
}

screen_has() { # screen_has <extended-regex>
  grep -Eqi -- "$1" "$PANE" 2>/dev/null
}

matched_text() { # matched_text <extended-regex>
  grep -Ei -- "$1" "$PANE" 2>/dev/null | head -1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | cut -c1-160
}

matched_fragment() { # matched_fragment <extended-regex>  (just the match, for clean evidence)
  grep -Eo -- "$1" "$PANE" 2>/dev/null | head -1
}

wait_for() { # wait_for <label> <extended-regex> <timeout-seconds>
  label="$1"
  pattern="$2"
  timeout="$3"
  deadline=$((SECONDS + timeout))
  while :; do
    capture
    if screen_has "$pattern"; then
      return 0
    fi
    if ! "$TMUX_BIN" -L "$SOCK" has-session -t "$SESSION" 2>/dev/null; then
      return 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.25
  done
}

type_text() { # literal keystrokes, no Enter
  "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" -l -- "$1" 2>/dev/null
}

press() { # press <tmux key name...>
  "$TMUX_BIN" -L "$SOCK" send-keys -t "$SESSION" "$@" 2>/dev/null
}

# Type into the prompt and require the text to be visible in the input box
# before submitting; a swallowed keystroke must never fake a failure.
type_prompt() { # type_prompt <text>
  text="$1"
  attempt=1
  while [ "$attempt" -le 2 ]; do
    type_text "$text"
    deadline=$((SECONDS + 10))
    while :; do
      capture
      if grep -Fq -- "$text" "$PANE" 2>/dev/null; then
        return 0
      fi
      if [ "$SECONDS" -ge "$deadline" ]; then
        break
      fi
      sleep 0.2
    done
    press Escape 2>/dev/null || true
    sleep 0.3
    attempt=$((attempt + 1))
  done
  return 1
}

# Answer an approval dialog with the key the UI expects. Bonus path only: no
# dialog is expected for the write step under the default on-request posture, so
# a non-zero return never fails the journey on its own (the caller keeps polling
# the filesystem either way):
#   Guard dialog    default selection is "Deny (default)"; the allow action is
#                   the previous enabled option -> Up, then Enter.
#   Permission      default selection is the first option "Allow once" -> Enter.
answer_dialog() {
  if screen_has 'Guard approval'; then
    if screen_has 'Allow unavailable'; then
      return 2
    fi
    press Up 2>/dev/null || true
    sleep 0.4
    capture
    if screen_has 'Allow unavailable'; then
      return 2
    fi
    press Enter 2>/dev/null || true
    return 0
  fi
  screen_has 'Allow once' || return 3
  press Enter 2>/dev/null || true
  return 0
}

# ---------------------------------------------------------------------------
# Assertion 1 - boot: welcome screen + input box rendered in a real PTY.
# ---------------------------------------------------------------------------
if wait_for boot 'Ask anything' "$BOOT_TIMEOUT"; then
  say "ASSERT boot PASS match=\"$(matched_text 'Ask anything')\""
else
  fail boot "TUI never rendered its prompt within ${BOOT_TIMEOUT}s (pane $(wc -l < "$PANE" 2>/dev/null || echo 0) lines; blank pane can mean an unresolvable import - retry with --preflight)"
fi

# A first-run provider/model chooser would swallow the keystrokes below.
if screen_has 'Select a connected provider/model|Connect a provider'; then
  say "STEP boot: dismissing first-run provider dialog"
  press Escape 2>/dev/null || true
  wait_for boot-main 'Ask anything' 30 || fail boot "welcome screen did not appear after dismissing the provider dialog"
fi

# ---------------------------------------------------------------------------
# Assertion 2 - streaming: first token renders before the last one.
# ---------------------------------------------------------------------------
say "STEP stream: submitting a prompt and watching incremental rendering"
type_prompt "PTY-STREAM please stream these tokens" || fail stream "typed prompt never appeared in the input box"
press Enter 2>/dev/null || true

if wait_for stream-first 'STREAM-ALPHA' "$STEP_TIMEOUT"; then
  if screen_has 'STREAM-OMEGA'; then
    fail stream "whole response was already on screen at first capture; incremental rendering not observable"
  fi
  cp "$PANE" "$LOGS/screen-stream-partial.txt" 2>/dev/null || true
  say "ASSERT stream-partial PASS match=\"$(matched_text 'STREAM-ALPHA')\" (last token not yet rendered)"
else
  fail stream "first streamed token never rendered within ${STEP_TIMEOUT}s"
fi
wait_for stream-done 'STREAM-OMEGA' "$STEP_TIMEOUT" || fail stream "streamed response never completed"
say "ASSERT stream-done PASS match=\"$(matched_text 'STREAM-OMEGA')\""

# ---------------------------------------------------------------------------
# Assertion 3 - permission matrix UI. Sandbox and approval are independent
# dimensions; `/permissions` must render both, which is the permission UX this
# journey asserts. (No dialog is expected for the write below: under the
# default on-request + workspace-write posture a routine in-workspace write is
# quietly admitted, so waiting for a dialog there was the wrong expectation.)
# ---------------------------------------------------------------------------
permission_sandbox='Sandbox · Read only'
permission_approval='Approval · Never'
say "STEP permissions: opening the permission matrix with /permissions"
perm_ok=0
perm_attempt=1
while [ "$perm_attempt" -le 2 ]; do
  press Escape 2>/dev/null || true
  sleep 0.3
  type_prompt "/permissions" || fail permissions "typed '/permissions' never appeared in the input box"
  press Enter 2>/dev/null || true
  if wait_for permissions-dialog 'Permissions · Direct Session' 20; then
    if wait_for permissions-matrix "$permission_sandbox" 20; then
      if screen_has "$permission_approval"; then
        perm_ok=1
        break
      fi
    fi
  fi
  perm_attempt=$((perm_attempt + 1))
done
capture
[ "$perm_ok" = "1" ] || fail permissions "the permission matrix dialog did not render both dimensions within ${STEP_TIMEOUT}s (need 'Sandbox · Read only' and 'Approval · Never'); screen=$(matched_text 'Permissions|permission posture|Loading authenticated')"
cp "$PANE" "$LOGS/screen-permissions-dialog.txt" 2>/dev/null || true
say "ASSERT permissions PASS dialog=\"$(matched_fragment 'Permissions · Direct Session')\" sandbox=\"$(matched_fragment "$permission_sandbox")\" approval=\"$(matched_fragment "$permission_approval")\" posture=\"$(matched_fragment 'Current: [a-z-]+ · [a-z-]+')\""

press Escape 2>/dev/null || true
dismissed=0
dismiss_deadline=$((SECONDS + 30))
while :; do
  capture
  if ! screen_has 'Permissions · Direct Session'; then
    dismissed=1
    break
  fi
  if [ "$SECONDS" -ge "$dismiss_deadline" ]; then
    break
  fi
  sleep 0.25
done
[ "$dismissed" = "1" ] || fail permissions "Escape did not dismiss the permission dialog within 30s"
say "ASSERT permissions-dismiss PASS escape closed the dialog (session view restored)"

# ---------------------------------------------------------------------------
# Assertion 4 - the in-workspace write executes under the default posture.
# approval=on-request + sandbox=workspace-write admits routine in-workspace
# work through a quiet prepared lease (DEC-V1-28), so the evidence is the file
# on disk with the EXACT expected bytes plus the assistant reporting completion,
# not a dialog. A dialog that does appear is answered with the allow key (bonus
# path), but its absence is never a failure.
# ---------------------------------------------------------------------------
dialog_pattern='Permission required|Guard approval|Allow once'
say "STEP write: submitting the write prompt"
type_prompt "PTY-WRITE create the journey file now" || fail write "typed prompt never appeared in the input box"
press Enter 2>/dev/null || true

write_ok=0
file_exact=0
completion_seen=0
dialog_seen=0
dialogs_answered=0
write_deadline=$((SECONDS + STEP_TIMEOUT))
while :; do
  capture
  completion_seen=0
  if screen_has 'WRITE-STEP COMPLETE'; then completion_seen=1; fi
  file_exact=0
  if [ -f "$TARGET_FILE" ] && cmp -s "$RUN/expected.txt" "$TARGET_FILE"; then file_exact=1; fi
  if [ "$file_exact" = "1" ] && [ "$completion_seen" = "1" ]; then
    write_ok=1
    break
  fi
  if screen_has "$dialog_pattern"; then
    dialog_seen=1
    if [ "$dialogs_answered" -lt 3 ]; then
      dialogs_answered=$((dialogs_answered + 1))
      answer_rc=0
      answer_dialog || answer_rc=$?
      say "STEP write: an approval dialog appeared (bonus path, rc=$answer_rc): $(matched_text "$dialog_pattern")"
      sleep 0.4
      continue
    fi
  fi
  if [ "$SECONDS" -ge "$write_deadline" ]; then
    break
  fi
  sleep 0.25
done

if [ "$write_ok" != "1" ]; then
  file_state="absent"
  if [ -e "$TARGET_FILE" ]; then
    observed_bytes="$(wc -c < "$TARGET_FILE" 2>/dev/null | tr -d '[:space:]')"
    if cmp -s "$RUN/expected.txt" "$TARGET_FILE"; then
      file_state="present bytes=$observed_bytes content=exact"
    else
      file_state="present bytes=$observed_bytes content=[$(head -c 160 "$TARGET_FILE" 2>/dev/null | tr '\n' ' ')]"
    fi
  fi
  say "EVIDENCE write file=$file_state expected=[$EXPECTED_CONTENT] completion_seen=$completion_seen dialog_seen=$dialog_seen dialogs_answered=$dialogs_answered"
  say "EVIDENCE project listing: $(ls -la "$PROJECT" 2>/dev/null | tr '\n' '|' | cut -c1-600)"
  if [ "$file_exact" = "1" ]; then
    fail write "the journey file is exact on disk but the assistant never rendered 'WRITE-STEP COMPLETE' within ${STEP_TIMEOUT}s (file=$file_state)"
  fi
  fail write "the in-workspace write did not produce the expected bytes within ${STEP_TIMEOUT}s (file=$file_state expected_bytes=$(wc -c < "$RUN/expected.txt" | tr -d '[:space:]'))"
fi

cp "$PANE" "$LOGS/screen-write-complete.txt" 2>/dev/null || true
actual_bytes="$(wc -c < "$TARGET_FILE" | tr -d '[:space:]')"
expected_bytes="$(wc -c < "$RUN/expected.txt" | tr -d '[:space:]')"
[ "$actual_bytes" = "$expected_bytes" ] || fail write "file size $actual_bytes != expected $expected_bytes"
cmp -s "$RUN/expected.txt" "$TARGET_FILE" || fail write "file content mismatch: got [$(head -c 200 "$TARGET_FILE" | tr '\n' ' ')]"
say "ASSERT write PASS dialogs_answered=$dialogs_answered file=${TARGET_FILE#"$ROOT"/} bytes=$actual_bytes content=[$EXPECTED_CONTENT]"

# ---------------------------------------------------------------------------
# Assertion 5 - clean quit (Ctrl-C is the documented app_exit binding).
# ---------------------------------------------------------------------------
say "STEP quit: sending Ctrl-C and waiting for a zero exit code"
press C-c 2>/dev/null || true
if ! wait_for quit '::TUI_EXIT::' 20; then
  press C-d 2>/dev/null || true
  wait_for quit '::TUI_EXIT::' 20 || fail quit "TUI did not exit after Ctrl-C/Ctrl-D within 40s"
fi
exit_line="$(grep -o '::TUI_EXIT::[0-9]*' "$PANE" | tail -1 || true)"
[ "$exit_line" = "::TUI_EXIT::0" ] || fail quit "TUI exited non-zero: ${exit_line:-no marker}"
"$TMUX_BIN" -L "$SOCK" has-session -t "$SESSION" 2>/dev/null || fail quit "tmux session vanished before the final capture"
say "ASSERT quit PASS ${exit_line} clean exit"

# Final settle: one bounded pause so the last frame is fully painted before the
# final capture (the only sleep in this script longer than 1s).
sleep 1
capture
cp "$PANE" "$LOGS/screen-final.txt" 2>/dev/null || true

say "EVIDENCE tmux_socket=$SOCK pane=140x42 base=$BASE model=opencode/e2e-offline kernel=hz-kernel"
say "EVIDENCE assertions=boot,stream-partial,stream-done,permissions,permissions-dismiss,write,quit"
say "EVIDENCE file_bytes=$actual_bytes permission_dialogs=$dialogs_answered dialog_seen=$dialog_seen"
say "PASS"
say "E2E_V1_TUI_PTY_JOURNEY=PASS"
STATUS=0
exit 0
