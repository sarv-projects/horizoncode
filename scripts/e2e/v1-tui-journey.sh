#!/usr/bin/env bash
# scripts/e2e/v1-tui-journey.sh
#
# HorizonCode V1 LIVE TUI PTY journey (Lead 6).
#
# Boots the REAL HorizonCode TUI (`horizoncode` default command = the opencode
# TUI entry) inside a real PTY, drives it with keystrokes and asserts the
# rendered screen (tmux pane capture = a real terminal emulator interpreting
# the TUI's ANSI output), fully offline against the same pinned loopback mock
# model as scripts/e2e/v1-smoke.sh (opencode/e2e-offline, cost 0, 127.0.0.1
# only, provider credential env scrubbed, models.dev fetch disabled).
#
# Journeys (each prints JOURNEY <id> PASS|FAIL with the matched screen text):
#   a  boot     the TUI renders its welcome screen and input box
#   b  stream   a prompt is submitted and the response streams token by token
#   c  approval a guarded write action raises the approval dialog, which is
#               ACCEPTED once (file written) and then DENIED (no file)
#   d  scroll   the transcript is scrolled up and earlier lines become visible
#   e  slash    typing "/" opens the slash-command list
#
# HostKernel / Guard: the source-mode CLI has no build-time kernel defines
# (packages/horizoncode/script/build.ts injects them only into compiled
# binaries) and the TUI server runs inside a Bun Worker whose globals the
# entry process cannot reach. Injecting the canonical kernel manifest through
# an OPENCODE_WORKER_PATH worker wrapper was tried first: the manifest was
# read (the asset installed under cache/opencode/bin/hz-kernel/<sha>) but the
# TUI then hung before creating its instance, so this journey runs the
# fail-closed source-mode path and drives the guarded-write approval dialog
# through the ordinary permission ask. Recorded in .tmp/tui-audit.md.
#
# State: everything lives under .tmp/tui-journey/<tag> (unique RUN_ID), logs
# survive under .tmp/tui-journey/logs/v1-tui-journey-<RUN_ID>. Repeats and
# concurrent runs never collide.
#
# Exit: 0 only when every journey passed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JDIR="$ROOT/.tmp/tui-journey"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
# Short tag: the HostKernel unix socket lives under RUN and must stay <108 bytes.
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum 2>/dev/null | cut -c1-8)"
if ! printf '%s' "$RUN_TAG" | grep -Eq '^[0-9a-f]{8}$'; then
  printf 'E2E_V1_TUI_JOURNEY=FAIL\nEVIDENCE_FAIL step=env detail=could not derive an 8-hex run tag\n' >&2
  exit 1
fi
RUN="$JDIR/tj-$RUN_TAG"
LOGS="$JDIR/logs/v1-tui-journey-$RUN_ID"
PROJECT="$RUN/work"
OK_FILE="$PROJECT/approved-$RUN_ID.txt"

ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$RUN/state"
export PATH="$ORIG_HOME/.bun/bin:$PATH"
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_AUTH_CONTENT="{}"

if ! mkdir "$RUN" 2>/dev/null; then
  printf 'E2E_V1_TUI_JOURNEY=FAIL\nEVIDENCE_FAIL step=env detail=run dir exists (tag collision): %s\n' "$RUN" >&2
  exit 1
fi
mkdir -p "$RUN"/home "$RUN"/config/opencode "$RUN"/data "$RUN"/state "$RUN"/cache "$RUN"/tmp "$PROJECT" "$LOGS" || {
  printf 'E2E_V1_TUI_JOURNEY=FAIL\nEVIDENCE_FAIL step=env detail=cannot create run tree\n' >&2
  exit 1
}

SOCK="hz-tui-$$"
MOCK_PID=""
RESULTS=()

say() { printf '%s\n' "$*"; }

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  tmux -L "$SOCK" kill-server 2>/dev/null
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill -TERM "$MOCK_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$MOCK_PID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$MOCK_PID" 2>/dev/null
  fi
  rm -rf "$RUN"
  exit "$rc"
}
trap 'cleanup' EXIT
trap 'exit 130' INT TERM

# --- journey bookkeeping -----------------------------------------------------
FAILED=0
journey_result() {  # id verdict detail
  local id="$1" verdict="$2" detail="$3"
  RESULTS+=("JOURNEY $id $verdict $detail")
  say "JOURNEY $id $verdict $detail"
  [ "$verdict" = "PASS" ] || FAILED=1
}

# --- screen helpers ----------------------------------------------------------
SCREEN="$LOGS/screen-latest.txt"
capture() {  # capture <label>
  local label="$1"
  tmux -L "$SOCK" capture-pane -p -t tui > "$LOGS/screen-$label.txt" 2>/dev/null || true
  cp "$LOGS/screen-$label.txt" "$SCREEN" 2>/dev/null || true
}

# Strip the launch command echo and keep the TUI frame only (best effort):
# everything after the first line that the TUI painted is what we match on,
# but matching is done on the whole pane - assertions use unique markers.
screen_has() {  # screen_has <regex> <file>
  grep -Eqi "$2" "$1" 2>/dev/null
}

wait_for() {  # wait_for <label> <regex> <timeout_s>
  local label="$1" pattern="$2" timeout="$3" start now
  start=$(date +%s)
  while :; do
    capture "$label"
    if screen_has "$SCREEN" "$pattern"; then
      now=$(( $(date +%s) - start ))
      return 0
    fi
    if ! tmux -L "$SOCK" has-session -t tui 2>/dev/null; then
      say "EVIDENCE_FAIL step=wait_for label=$label detail=tmux session died"
      return 1
    fi
    [ $(( $(date +%s) - start )) -ge "$timeout" ] && return 1
    sleep 0.5
  done
}

matched_text() {  # matched_text <regex> <file> -> first matching line, trimmed
  grep -Ei "$1" "$2" 2>/dev/null | head -1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | cut -c1-160
}

type_text() {  # literal keystrokes (no Enter)
  tmux -L "$SOCK" send-keys -t tui -l -- "$1" 2>/dev/null
}
press() {  # press <tmux key name...>
  tmux -L "$SOCK" send-keys -t tui "$@" 2>/dev/null
}

# --- 1. offline mock LLM (same shape as v1-smoke.sh) ------------------------
cat > "$RUN/mock-llm.py" <<'PYMOCK'
#!/usr/bin/env python3
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH, WRITE_TARGET = sys.argv[1], sys.argv[2]
LOCK = threading.Lock()
CHUNK_GAP = 0.3
FIRST_TOKEN_PAUSE = 4.0

def log_event(mode, path):
    try:
        with LOCK:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": time.time(), "mode": mode, "path": path}) + "\n")
    except Exception:
        pass

def chunk(delta, finish=None):
    c = {"id": "chatcmpl-tui", "object": "chat.completion.chunk", "created": 0,
         "model": "e2e-offline", "choices": [{"index": 0, "delta": delta}]}
    if finish:
        c["choices"][0]["finish_reason"] = finish
    return ("data: " + json.dumps(c) + "\n\n").encode()

def send_sse(steps):
    try:
        yield_chunk = steps
        return yield_chunk
    except Exception:
        return None

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
        self._json({"ok": True, "service": "tui-journey-mock-llm"})
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
            self._text(["TUI Journey Title"])
            return
        # Journey routing is decided ONLY by the newest user turn: once one tool
        # call is in history every later request carries tool parts, so a whole-body
        # match would answer every remaining journey with the same final text.
        last_user = ""
        for m in msgs:
            if isinstance(m, dict) and m.get("role") == "user":
                c = m.get("content")
                if isinstance(c, str):
                    last_user = c
                elif isinstance(c, list):
                    last_user = " ".join(x.get("text", "") for x in c if isinstance(x, dict)) or last_user
        # A tool call is answered only when the CURRENT turn already produced one:
        # checking the whole history would answer every later journey with the
        # same final text, while ignoring it would loop the tool call forever.
        last_user_index = -1
        for index in range(len(msgs) - 1, -1, -1):
            message = msgs[index]
            if isinstance(message, dict) and message.get("role") == "user":
                last_user_index = index
                break
        turn = msgs[last_user_index:] if last_user_index >= 0 else msgs
        has_tool_turn = any(isinstance(m, dict) and (m.get("role") == "tool" or m.get("tool_calls")) for m in turn)
        if has_tool_turn:
            log_event("final", self.path)
            self._text(["WRITE-STEP COMPLETE", "done"])
            return
        if "TUI-WRITE" in last_user:
            log_event("write_call", self.path)
            self._write_call()
            return
        if "TUI-LONG" in last_user:
            log_event("long", self.path)
            self._long()
            return
        if "TUI-STREAM" in last_user:
            log_event("text", self.path)
            self._stream(["STREAM-ALPHA ", "STREAM-BETA ", "STREAM-GAMMA ", "STREAM-DELTA ", "STREAM-OMEGA"])
            return
        log_event("text", self.path)
        self._stream(["STREAM-ALPHA ", "STREAM-BETA ", "STREAM-GAMMA ", "STREAM-DELTA ", "STREAM-OMEGA"])
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
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
    def _stream(self, parts):
        # First token is delivered alone, then a deliberate pause: the journey
        # asserts a frame that shows the first token WITHOUT the last one, so
        # the TUI's incremental render is observable deterministically.
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
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
    def _long(self):
        try:
            self._headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({"content": "SCROLL-ANCHOR-001 begins the long transcript\n"}))
            for i in range(2, 61):
                self.wfile.write(chunk({"content": "SCROLL-LINE-%03d of the journey transcript\n" % i}))
            self.wfile.write(chunk({"content": "\nSCROLL-END-060 reached"}))
            self.wfile.write(chunk({}, finish="stop"))
            self.wfile.write(DONE)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
    def _write_call(self):
        args = json.dumps({"filePath": WRITE_TARGET, "content": "OK\n"})
        try:
            self._headers()
            self.wfile.write(chunk({"role": "assistant"}))
            self.wfile.write(chunk({"tool_calls": [{
                "index": 0, "id": "call_tui_write", "type": "function",
                "function": {"name": "write", "arguments": args},
            }]}))
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
[ -s "$RUN/mock-llm.py" ] || { say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=mock detail=cannot write mock"; exit 1; }

MOCK_LOG="$LOGS/llm-hits.jsonl"
: > "$MOCK_LOG"
python3 "$RUN/mock-llm.py" "$MOCK_LOG" "$OK_FILE" > "$LOGS/mock.out" 2>&1 &
MOCK_PID=$!
MOCK_PORT=""
for _ in $(seq 1 100); do
  MOCK_PORT="$(sed -n 's/^MOCK_READY port=\([0-9]*\)$/\1/p' "$LOGS/mock.out" 2>/dev/null | head -n1)"
  [ -n "$MOCK_PORT" ] && break
  kill -0 "$MOCK_PID" 2>/dev/null || { say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=mock detail=mock died"; exit 1; }
  sleep 0.2
done
[ -n "$MOCK_PORT" ] || { say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=mock detail=no port"; exit 1; }
MOCK_BASE="http://127.0.0.1:$MOCK_PORT"
case "$(curl -sS --max-time 5 "$MOCK_BASE/health" 2>/dev/null)" in
  *tui-journey-mock-llm*) ;;
  *) say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=mock detail=health probe failed"; exit 1 ;;
esac
say "STEP mock: loopback mock LLM on $MOCK_BASE (pid=$MOCK_PID)"

# Inline loopback-only catalog (zero egress, cost 0) - same shape as v1-smoke.
mkdir -p "$RUN/catalog"
python3 - "$RUN/catalog/models.json" "$MOCK_BASE/v1" <<'PY'
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
[ -s "$RUN/catalog/models.json" ] || { say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=catalog detail=cannot write catalog"; exit 1; }
export OPENCODE_MODELS_PATH="$RUN/catalog/models.json"
say "CATALOG inline opencode/e2e-offline api=$MOCK_BASE/v1 cost=0"

# Primary AgentProfileV2 (agent-profile-only global file; same as v1-smoke).
python3 - > "$RUN/config/opencode/opencode.json" <<'PY'
import json
profile = {
    "schemaVersion": 2, "profileId": "user.primary", "revision": "1",
    "name": "V1 TUI Primary", "description": "Primary profile for the V1 TUI journey",
    "source": "user", "roles": ["main"],
    "purpose": "Authorize the pinned opencode/e2e-offline direct route",
    "whenToUse": "V1 TUI E2E", "whenNotToUse": "Production",
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
[ -s "$RUN/config/opencode/opencode.json" ] || { say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=config detail=cannot write profile config"; exit 1; }
say "CONFIG primary-agent-profile model=opencode/e2e-offline role=main"

# Isolated permission policy: NOTHING is pre-allowed, so the guarded write
# raises a real approval ask (fail-closed default "ask").
export OPENCODE_CONFIG_CONTENT='{"permission":{"write":"ask","files.write":"ask"}}'

# --- 2. HostKernel / Guard note --------------------------------------------
# Source-mode `bun run` has no build-time HostKernel defines
# (packages/horizoncode/script/build.ts injects them only into compiled binaries)
# and the TUI server runs inside a Bun Worker, so the entry process cannot
# publish them to it. Injecting the canonical kernel manifest through an
# OPENCODE_WORKER_PATH worker wrapper was tried first: the manifest WAS read
# (the asset is installed under cache/opencode/bin/hz-kernel/<sha>) but the
# TUI then hung before creating its instance, so this journey runs the
# fail-closed source-mode path instead and drives the TUI's approval dialog on
# the guarded write through the ordinary permission ask (kernel-independent).
# Recorded in .tmp/tui-audit.md as a gap.
# --- 3. provider credential scrub for the TUI process -----------------------
SCRUB=()
while IFS='=' read -r name _rest; do
  [ -n "$name" ] || continue
  case "$name" in
    OPENCODE_SERVER_PASSWORD|OPENCODE_MODELS_PATH|OPENCODE_CONFIG_CONTENT|PROBE_MARK) continue ;;
    *API_KEY*|*APIKEY*|*_TOKEN*|*_SECRET*|*SECRET*|*CREDENTIAL*|*PASSWORD*) SCRUB+=(-u "$name") ;;
  esac
done < <(env)
say "ENV scrub flags=${#SCRUB[@]}"

# --- 3b. preflight: the TUI worker graph must resolve before we open a PTY ----
# The TUI server runs in a Bun Worker; if any module in that graph is missing the
# Worker never starts, `validateSession` never returns and the TUI hangs with a
# blank screen and NO error (observed live). Bundle it first and fail fast with a
# named import instead. Skip with TUI_JOURNEY_SKIP_PREFLIGHT=1.
if [ -z "${TUI_JOURNEY_BIN:-}" ] && [ "${TUI_JOURNEY_SKIP_PREFLIGHT:-0}" != "1" ]; then
  say "STEP preflight: bundling packages/horizoncode/src/cli/tui/worker.ts (fail fast on broken imports)"
  ( cd "$ROOT/packages/horizoncode" && timeout 420 "$ORIG_HOME/.bun/bin/bun" build ./src/cli/tui/worker.ts \
      --target=bun --outdir "$RUN/preflight" > "$LOGS/preflight.log" 2>&1 )
  preflight_rc=$?
  # Bun prints benign "Could not resolve" lines for optional platform variants of
  # @opentui/core; every other resolve/syntax error is fatal for the worker.
  bad_errors="$(grep -E '^error:' "$LOGS/preflight.log" 2>/dev/null | grep -vE '@opentui/core-(darwin|linux|win32)-' || true)"
  if [ "$preflight_rc" -ne 0 ] || [ -n "$bad_errors" ]; then
    say "E2E_V1_TUI_JOURNEY=FAIL"
    say "EVIDENCE_FAIL step=preflight detail=TUI worker graph does not compile (rc=$preflight_rc)"
    printf '%s\n' "$bad_errors" | head -8 | sed 's/^/EVIDENCE_IMPORT /'
    say "LOGS=$LOGS"
    exit 1
  fi
  say "STEP preflight: TUI worker graph resolves"
fi
# --- 4. boot the TUI inside a real PTY ---------------------------------------
tmux -L "$SOCK" kill-server 2>/dev/null
tmux -L "$SOCK" new-session -d -s tui -x 140 -y 42 -c "$PROJECT" "export PATH='$ORIG_HOME/.bun/bin:'\"\$PATH\"; exec bash --norc" || {
  say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=pty detail=tmux session could not start"; exit 1; }
tmux -L "$SOCK" pipe-pane -o -t tui "cat >> '$LOGS/pty-raw.log'"

# Boot command: default = the source-mode dev entry (cwd must stay
# packages/horizoncode - see .tmp/tui-audit.md A2). TUI_JOURNEY_BIN=<path> opts in
# to a prebuilt CLI (packages/horizoncode/dist/...), which is self-consistent but
# STALE relative to the tree; results from that mode must be labelled as such.
if [ -n "${TUI_JOURNEY_BIN:-}" ]; then
  [ -x "$TUI_JOURNEY_BIN" ] || { say "E2E_V1_TUI_JOURNEY=FAIL"; say "EVIDENCE_FAIL step=bin detail=not executable: $TUI_JOURNEY_BIN"; exit 1; }
  # Zero egress for the prebuilt build: it tries a background npm install of its
  # own version, so point every package registry at a dead loopback port.
  BIN_ENV="NPM_CONFIG_REGISTRY=http://127.0.0.1:9/ npm_config_registry=http://127.0.0.1:9/ BUN_CONFIG_REGISTRY=http://127.0.0.1:9/"
  BOOT_CMD="env $BIN_ENV '$TUI_JOURNEY_BIN'"
  say "STEP boot: prebuilt CLI mode TUI_JOURNEY_BIN=$TUI_JOURNEY_BIN (stale-build caveat; preflight skipped)"
else
  BOOT_CMD="'$ORIG_HOME/.bun/bin/bun' run src/index.ts"
fi
LAUNCH="export HOME='$HOME' XDG_CONFIG_HOME='$XDG_CONFIG_HOME' XDG_DATA_HOME='$XDG_DATA_HOME' XDG_STATE_HOME='$XDG_STATE_HOME' XDG_CACHE_HOME='$XDG_CACHE_HOME' TMPDIR='$TMPDIR'; export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_AUTH_CONTENT='{}' OPENCODE_MODELS_PATH='$OPENCODE_MODELS_PATH' OPENCODE_CONFIG_CONTENT='$OPENCODE_CONFIG_CONTENT'; export PATH='$ORIG_HOME/.bun/bin:'\"\$PATH\"; cd '$ROOT/packages/horizoncode'; env ${SCRUB[@]+"${SCRUB[@]}"} $BOOT_CMD --model opencode/e2e-offline --project '$PROJECT'; echo ::TUI_EXIT::\$?; sleep 600"
tmux -L "$SOCK" send-keys -t tui -l -- "$LAUNCH"
tmux -L "$SOCK" send-keys -t tui Enter
say "STEP pty: tmux socket=$SOCK size=140x42 boot=$BOOT_CMD model=opencode/e2e-offline"

# --------------------------------------------------------------------------
# JOURNEY a: boot + welcome/input
# --------------------------------------------------------------------------
if wait_for "a-boot" 'Ask anything' 600; then
  m="$(matched_text 'Ask anything' "$SCREEN")"
  journey_result "a-boot" "PASS" "match=\"$m\""
else
  journey_result "a-boot" "FAIL" "detail=no welcome input within timeout; screen=$(tail -c 200 "$SCREEN" 2>/dev/null | tr '\n' ' ')"
fi

# Any first-run provider dialog must not swallow the keystrokes below.
if screen_has "$SCREEN" 'Select a connected provider/model|Connect a provider'; then
  if wait_for "a-dialog" 'Select a connected provider/model|Connect a provider' 10; then
    press Escape
    sleep 1
    capture "a-after-esc"
  fi
fi

# --------------------------------------------------------------------------
# JOURNEY b: type a prompt, see the response stream token by token
# --------------------------------------------------------------------------
type_prompt_text() {  # type_prompt_text <text>: visible-in-input or not
  local text="$1" attempt t
  for attempt in 1 2; do
    type_text "$text"
    t=0
    while [ "$t" -lt 16 ]; do
      sleep 0.5
      capture "typed-$attempt"
      screen_has "$SCREEN" "$text" && return 0
      tmux -L "$SOCK" has-session -t tui 2>/dev/null || return 1
      t=$((t + 1))
    done
    press Escape
    sleep 1
  done
  return 1
}
if type_prompt_text "TUI-STREAM please stream now"; then
  press Enter
  # first chunk should land quickly; assert it is visible while the last token
  # has NOT arrived yet (the mock pauses 1.5s after the first token)
  if wait_for "b-first" 'STREAM-ALPHA' 240; then
    if screen_has "$SCREEN" 'STREAM-OMEGA'; then
      journey_result "b-stream" "FAIL" "detail=whole response arrived before the first capture; streaming window not observable"
    else
      m="$(matched_text 'STREAM-ALPHA' "$SCREEN")"
      journey_result "b-stream" "PASS" "match=\"$m\" (partial frame, last token not yet rendered)"
    fi
    if wait_for "b-done" 'STREAM-OMEGA' 120; then
      journey_result "b-stream-done" "PASS" "match=\"$(matched_text 'STREAM-OMEGA' "$SCREEN")\""
    else
      journey_result "b-stream-done" "FAIL" "detail=response never completed"
    fi
  else
    journey_result "b-stream" "FAIL" "detail=first streamed token never rendered"
  fi
else
  press Enter
  journey_result "b-stream" "FAIL" "detail=typed prompt never appeared in the input box"
fi

# --------------------------------------------------------------------------
# JOURNEY c: guarded write -> approval dialog -> accept, then deny
# --------------------------------------------------------------------------
send_prompt() {  # send_prompt <text>: verified typing, then submit
  press Escape 2>/dev/null
  sleep 0.5
  type_prompt_text "$1" || true   # verified-in-input (retries) so a swallowed
  sleep 0.3                       # first keystroke can never fake a FAIL
  press Enter
}
guard_dialog_pattern='Guard approval|Deny \(default\)'
permission_dialog_pattern='Allow once|Call tool write|This will allow|Permission(s)\? [0-9]|△ [0-9] Permission'

c_first_ok=0
send_prompt "TUI-WRITE guarded write for the journey"
if wait_for "c-dialog" "$guard_dialog_pattern|$permission_dialog_pattern" 240; then
  m="$(matched_text "$guard_dialog_pattern|$permission_dialog_pattern" "$SCREEN")"
  kind="guard"
  printf '%s' "$m" | grep -Eqi 'Guard approval|Deny \(default\)' || kind="permission"
  cp "$SCREEN" "$LOGS/screen-c-dialog-$kind.txt"
  # ACCEPT: default option differs (permission defaults to "allow once",
  # guard defaults to "deny"), so select explicitly then confirm.
  if [ "$kind" = "guard" ]; then
    press Up 2>/dev/null || true      # move off "Deny (default)" towards Allow
    sleep 0.4
    capture "c-select"
    if ! screen_has "$SCREEN" 'Allow'; then press Down; fi
    sleep 0.4
  else
    : # "Allow once" is already the selected option
  fi
  press Enter
  if wait_for "c-accepted" 'WRITE-STEP COMPLETE' 240 && [ -f "$OK_FILE" ]; then
    journey_result "c-approve" "PASS" "dialog=$kind match=\"$m\" file=$(wc -c < "$OK_FILE") bytes"
    c_first_ok=1
  else
    journey_result "c-approve" "FAIL" "dialog=$kind detail=accept did not complete the guarded write (file_present=$([ -f "$OK_FILE" ] && echo yes || echo no))"
  fi
else
  journey_result "c-approve" "FAIL" "detail=approval dialog never appeared"
fi

rm -f "$OK_FILE"
c_denied_ok=0
send_prompt "TUI-WRITE guarded write that must be denied"
if wait_for "c-deny-dialog" "$guard_dialog_pattern|$permission_dialog_pattern" 240; then
  m="$(matched_text "$guard_dialog_pattern|$permission_dialog_pattern" "$SCREEN")"
  kind="guard"
  printf '%s' "$m" | grep -Eqi 'Guard approval|Deny \(default\)' || kind="permission"
  # DENY: permission dialog -> down x2 to "Reject"; guard dialog -> default Deny
  if [ "$kind" = "permission" ]; then
    press Down; sleep 0.3; press Down; sleep 0.3
    capture "c-deny-selected"
  fi
  press Enter
  sleep 6
  capture "c-deny-final"
  if [ -f "$OK_FILE" ]; then
    journey_result "c-deny" "FAIL" "dialog=$kind detail=denied action still wrote the file"
  else
    journey_result "c-deny" "PASS" "dialog=$kind match=\"$m\" file absent after deny"
    c_denied_ok=1
  fi
else
  journey_result "c-deny" "FAIL" "detail=approval dialog never appeared for the second guarded write"
fi

# --------------------------------------------------------------------------
# JOURNEY d: scroll the transcript
# --------------------------------------------------------------------------
send_prompt "TUI-LONG generate a long transcript"
if wait_for "d-long" 'SCROLL-END-060' 240; then
  capture "d-top-of-viewport"
  if screen_has "$SCREEN" 'SCROLL-ANCHOR-001'; then
    journey_result "d-scroll" "FAIL" "detail=anchor line already visible before scrolling; nothing to scroll"
  else
    press PageUp; sleep 1; press PageUp; sleep 1; press PageUp; sleep 1
    capture "d-scrolled-up"
    if screen_has "$SCREEN" 'SCROLL-ANCHOR-001'; then
      journey_result "d-scroll" "PASS" "match=\"$(matched_text 'SCROLL-ANCHOR-001' "$SCREEN")\" (line scrolled into view after PageUp x3)"
    else
      journey_result "d-scroll" "FAIL" "detail=PageUp x3 did not bring the transcript head into view"
    fi
  fi
else
  journey_result "d-scroll" "FAIL" "detail=long transcript never rendered"
fi

# --------------------------------------------------------------------------
# JOURNEY e: slash-command dialog
# --------------------------------------------------------------------------
press Escape 2>/dev/null || true
sleep 1
type_text "/"
if wait_for "e-slash" '/models|/agents|/sessions|/new' 90; then
  m="$(matched_text '/models|/agents|/sessions|/new' "$SCREEN")"
  journey_result "e-slash" "PASS" "match=\"$m\""
  press Escape
else
  journey_result "e-slash" "FAIL" "detail=slash command list never rendered"
fi

# --------------------------------------------------------------------------
capture "final"
if grep -q '::TUI_EXIT::' "$SCREEN" 2>/dev/null; then
  journey_result "a-liveness" "FAIL" "detail=TUI process exited during the run: $(grep -o '::TUI_EXIT::[0-9]*' "$SCREEN" | tail -1)"
else
  journey_result "a-liveness" "PASS" "match=\"$(matched_text 'Ask anything|stream|SCROLL|/' "$SCREEN")\" (TUI still running)"
fi

say "--- mock llm hits ---"
cut -c1-160 "$MOCK_LOG" 2>/dev/null | tail -12
say "--- log errors ---"
grep -iE 'level=ERROR' "$RUN/data/opencode/log/opencode.log" 2>/dev/null | tail -5 | cut -c1-240
say "LOGS=$LOGS"
if [ "$FAILED" -eq 0 ]; then
  say "E2E_V1_TUI_JOURNEY=PASS"
else
  say "E2E_V1_TUI_JOURNEY=FAIL"
fi
exit "$FAILED"