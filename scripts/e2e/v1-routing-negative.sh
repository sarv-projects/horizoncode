#!/usr/bin/env bash
# HorizonCode V1 provider-routing NEGATIVE journey (DEC-V1-32 / DEC-V1-36).
#
# Proves, at the journey level, that an explicitly selected provider route that
# is UNREACHABLE fails EXPLICITLY with NO hidden fallback to any other
# model/provider/route, at ZERO cost and with ZERO real provider traffic.
#
# Everything is local and hermetic:
#   * `opencode serve` boots with TWO custom providers injected via
#     OPENCODE_CONFIG_CONTENT, both using the BUNDLED @ai-sdk/openai-compatible
#     adapter (loaded from packages/opencode/node_modules -- no npm registry
#     fetch, no external provider code):
#       - route-primary  : the pinned "paid-looking" route; baseURL points at a
#                          LOCAL closed port -> TCP connection-refused.
#       - route-decoy    : the alternate route that must NEVER be silently
#                          selected; points at a DIFFERENT LOCAL closed port.
#   * models.dev refresh is disabled (OPENCODE_DISABLE_MODELS_FETCH=1) and a
#     repo-local fixture catalog is used.
#   * ALL provider API-key env vars are scrubbed from the server process.
#   * The only network event in the whole run is a loopback TCP connect that is
#     REFUSED. No request ever leaves 127.0.0.1; no provider is contacted; no
#     paid route can run.
#
# Journey:
#   1. boot offline server (bounded health retry) + background permission approver;
#   2. create a session, then send ONE prompt PINNED to route-primary, asking the
#      model to create a per-run scratch file IF it were to run;
#   3. assert the turn FAILS with an EXPLICIT surfaced error (not a hang, not a
#      fake success);
#   4. assert NO hidden fallback: no alternate provider/model was selected and
#      the assistant recorded the pinned route identity;
#   5. fail-closed: cost stays 0, no scratch artifact was created, and the turn
#      was never reported as a successful completion.
#
# Fail-closed: non-zero exit on ANY failed assertion, labelled steps, an
# E2E_V1_ROUTING_NEGATIVE=PASS/FAIL marker, and evidence lines. Per-run evidence
# lands under .tmp/e2e/logs/v1-routing-negative-$RUN_ID/.
#
# Usage:
#   bash scripts/e2e/v1-routing-negative.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/.tmp/e2e"
RUN="$E2E/routing-negative"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LOGS="$E2E/logs/v1-routing-negative-$RUN_ID"
ARTIFACT="$E2E/routing-negative-artifact-$RUN_ID.txt"

ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$RUN/state"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-v1-routing-negative-$RANDOM-$RANDOM}"

# Offline guard: never refresh models.dev; use a repo-local fixture catalog.
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_MODELS_PATH="$ROOT/packages/opencode/test/tool/fixtures/models-api.json"

# Pinned route identity under test (DEC-V1-32: the exact selected route).
PRIMARY_PROVIDER="route-primary"
PRIMARY_MODEL="primary-model"
DECOY_PROVIDER="route-decoy"
DECOY_MODEL="decoy-model"

mkdir -p "$RUN"/config "$RUN"/data "$RUN"/state "$RUN"/cache "$RUN"/home "$RUN"/tmp "$RUN"/work "$LOGS"

# Prefer the repo-local pinned Linux Bun 1.3.14; fall back to PATH.
REPO_BUN="$ROOT/.tmp/tools/bun-1.3.14/unpacked/bun-linux-x64/bun"
BUN="${BUN:-}"
if [ -z "$BUN" ] && [ -x "$REPO_BUN" ]; then BUN="$REPO_BUN"; fi
if [ -z "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [ -z "$BUN" ] && [ -x "$ORIG_HOME/.bun/bin/bun" ]; then BUN="$ORIG_HOME/.bun/bin/bun"; fi

SERVER_PID=""
APPROVER_PID=""
BASE=""
SERVER_PORT=""
PORTA=""
PORTB=""

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
  rm -f "$ARTIFACT"
  rm -rf "$RUN"
  cap_logs
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

fail() {
  step=$1
  shift
  say "E2E_V1_ROUTING_NEGATIVE=FAIL"
  say "EVIDENCE upto=$step porta=${PORTA:-none} portb=${PORTB:-none} session=${SID:-none} assistant=${STATE:-none} provider=${PROVIDER:-none} model=${MODEL:-none} cost=${COST:-none} error_present=${ERROR_PRESENT:-none} artifact=${ARTIFACT_PRESENT:-none}"
  say "EVIDENCE_FAIL step=$step detail=$(printf '%s' "$*" | cut -c1-600)"
  if [ -s "$LOGS/serve.log" ]; then
    say "--- serve.log tail ---"
    tail -n 15 "$LOGS/serve.log" | cut -c1-400
  fi
  say "LOGS=$LOGS"
  exit 1
}

[ -n "$BUN" ] || fail env "bun not found (tried \$BUN, repo-local .tmp/tools/bun-1.3.14, PATH, \$HOME/.bun/bin)"
[ "$OPENCODE_SERVER_PASSWORD" != "" ] || fail env "OPENCODE_SERVER_PASSWORD must be non-empty"

# ---------------------------------------------------------------------------
# Closed local ports: bind to an ephemeral loopback port, read it, close it,
# then verify a fresh TCP connect is REFUSED. This is the entire "network
# failure" surface of this journey -- a local connection that is refused.
# ---------------------------------------------------------------------------
closed_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); p=s.getsockname()[1]; s.close(); print(p)' 2>/dev/null
}

port_is_closed() {
  python3 - "$1" <<'PY' 2>/dev/null
import socket, sys
p = int(sys.argv[1])
s = socket.socket()
s.settimeout(1.5)
try:
    s.connect(("127.0.0.1", p))
    sys.exit(1)          # accepted -> something is listening (NOT closed)
except (ConnectionRefusedError, OSError):
    sys.exit(0)          # refused/unreachable -> closed, as required
finally:
    s.close()
PY
}

acquire_closed_port() {
  tries=0
  while [ "$tries" -lt 8 ]; do
    tries=$((tries + 1))
    p="$(closed_port || true)"
    if [ -n "${p:-}" ] && port_is_closed "$p"; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

PORTA="$(acquire_closed_port || true)"
[ -n "$PORTA" ] || fail env "could not acquire a closed local port for the primary route"
PORTB="$(acquire_closed_port || true)"
[ -n "$PORTB" ] || fail env "could not acquire a closed local port for the decoy route"
[ "$PORTA" != "$PORTB" ] || fail env "primary and decoy closed ports collided ($PORTA)"
say "PORTS primary_closed=$PORTA decoy_closed=$PORTB (loopback connect must be refused)"

# ---------------------------------------------------------------------------
# Two-provider offline config via OPENCODE_CONFIG_CONTENT. Both use the bundled
# openai-compatible adapter; both baseURLs are loopback closed ports.
# ---------------------------------------------------------------------------
python3 - "$PORTA" "$PORTB" > "$RUN/config-content.json" <<'PY'
import json, sys
porta, portb = sys.argv[1], sys.argv[2]

def model(mid, name):
    return {
        "id": mid,
        "name": name,
        "attachment": False,
        "reasoning": False,
        "temperature": False,
        "tool_call": True,
        "release_date": "2025-01-01",
        "limit": {"context": 100000, "output": 10000},
        "cost": {"input": 0, "output": 0},
        "options": {},
    }

def provider(name, port, mid, mname):
    return {
        "name": name,
        "id": name,
        "env": [],
        "npm": "@ai-sdk/openai-compatible",
        "models": {mid: model(mid, mname)},
        "options": {"apiKey": "e2e-unreachable-unused", "baseURL": "http://127.0.0.1:%s/v1" % port},
    }

config = {
    "permission": "allow",
    "provider": {
        "route-primary": provider("route-primary", porta, "primary-model", "Primary Unreachable Model"),
        "route-decoy": provider("route-decoy", portb, "decoy-model", "Decoy Alternate Model"),
    },
}
print(json.dumps(config))
PY
[ -s "$RUN/config-content.json" ] || fail env "failed to build OPENCODE_CONFIG_CONTENT"
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT="$(cat "$RUN/config-content.json")"
say "CONFIG two-providers primary=route-primary/$PRIMARY_MODEL@127.0.0.1:$PORTA decoy=route-decoy/$DECOY_MODEL@127.0.0.1:$PORTB"

# ---------------------------------------------------------------------------
# Primary AgentProfileV2 (Core Config, read from the GLOBAL user config file).
# A direct provider pin is only authorized when a configured primary profile
# (main role, Core-Config/user source) selects the SAME pinned provider/model.
# Without it the turn is rejected at the FIRST `direct_provider_authority` gate
# ("require the configured primary AgentProfileV2") before the route is even
# considered. Configuring it advances the pinned route through the DEC-V1-32
# authority chain. In a TypeScript-only `opencode serve` (no Rust HostKernel)
# the pin then stops at the HostKernel permission-mode-snapshot gate; where a
# HostKernel IS present the pin dispatches to the closed port and fails by
# connection-refused. BOTH outcomes are explicit fail-closed errors with NO
# hidden fallback (DEC-V1-32) -- exactly what this journey asserts.
# ---------------------------------------------------------------------------
mkdir -p "$XDG_CONFIG_HOME/opencode"
python3 - "$PRIMARY_PROVIDER" "$PRIMARY_MODEL" > "$XDG_CONFIG_HOME/opencode/opencode.json" <<'PY'
import json, sys
provider, model = sys.argv[1], sys.argv[2]
profile = {
    "schemaVersion": 2,
    "profileId": "user.primary",
    "revision": "1",
    "name": "Routing Negative Primary",
    "description": "Primary profile for the routing-negative journey",
    "source": "user",
    "roles": ["main"],
    "purpose": "Authorize the pinned direct provider route",
    "whenToUse": "Routing negative E2E",
    "whenNotToUse": "Production",
    "adapter": {"kind": "native", "adapterId": "horizon.native"},
    "model": {"providerId": provider, "modelId": model},
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
# NOTE: the global opencode.json must contain ONLY Core-Current agent-profile
# keys. Including an opencode/V1 marker key (e.g. "permission") makes Core's
# isV1() misclassify the file and route it through migrate(), which DROPS
# agent_profiles/agent_profile_selectors/primary_agent_profile_selector. The
# tool "permission" policy is carried separately via OPENCODE_CONFIG_CONTENT
# (opencode config), which is not parsed by this Core path.
config = {
    "agent_profiles": [profile],
    "agent_profile_selectors": [{"selector": "primary", "profileId": "user.primary", "revision": "1"}],
    "primary_agent_profile_selector": "primary",
}
print(json.dumps(config))
PY
[ -s "$XDG_CONFIG_HOME/opencode/opencode.json" ] || fail env "failed to write global opencode.json with primary AgentProfileV2"
say "CONFIG primary-agent-profile profileId=user.primary@1 model=$PRIMARY_PROVIDER/$PRIMARY_MODEL harness=native-rich role=main"

AUTH="$(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
AUTH="Basic $AUTH"

cat > "$RUN/parse_messages.py" <<'PY'
import json, sys

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
md = info.get("metadata") if isinstance(info.get("metadata"), dict) else {}
asst = md.get("assistant") if isinstance(md.get("assistant"), dict) else {}

def pick(*vals):
    for v in vals:
        if v is not None and v != "":
            return v
    return ""

error = pick(info.get("error"), md.get("error"))
cost = pick(info.get("cost"), asst.get("cost"))
provider = pick(info.get("providerID"), asst.get("providerID"))
model = pick(info.get("modelID"), asst.get("modelID"))
time_d = info.get("time") if isinstance(info.get("time"), dict) else (md.get("time") if isinstance(md.get("time"), dict) else {})
completed = time_d.get("completed")
done = bool(completed) or info.get("finish") is not None
texts = []
for p in parts:
    if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str):
        texts.append(p["text"])
print("STATE=%s" % ("done" if done else "running"))
print("COST=%s" % ("null" if cost in (None, "") else cost))
print("ERROR=%s" % (json.dumps(error) if error else ""))
print("ERROR_PRESENT=%s" % ("yes" if error else "no"))
print("PROVIDER=%s" % provider)
print("MODEL=%s" % model)
print("TEXT=%s" % json.dumps("".join(texts)))
print("TEXTPARTS=%d" % len(texts))
print("MSGCOUNT=%d" % len(msgs))
PY

# ---------------------------------------------------------------------------
# 1. Boot the offline server on a random high loopback port; bounded health retry.
#    ALL provider API keys are scrubbed from the server process.
# ---------------------------------------------------------------------------
start_server() {
  SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()' 2>/dev/null)
  [ -n "$SERVER_PORT" ] || return 1
  BASE="http://127.0.0.1:$SERVER_PORT"
  : > "$LOGS/serve.log"
  ( cd "$ROOT" && exec env \
      -u OPENCODE_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
      -u OPENCODE_GO_API_KEY -u GOOGLE_GENERATIVE_AI_API_KEY -u OPENROUTER_API_KEY \
      -u DEEPSEEK_API_KEY -u XAI_API_KEY -u GROQ_API_KEY -u COHERE_API_KEY -u MISTRAL_API_KEY \
      "$BUN" run --cwd packages/opencode src/index.ts serve --hostname 127.0.0.1 --port "$SERVER_PORT" ) \
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
# the non-interactive run. (The failed turn should never reach a tool, so this
# is defensive only.)
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
# 2. Create a session and send ONE prompt pinned to the UNREACHABLE route.
# ---------------------------------------------------------------------------
create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d '{"title":"v1-routing-negative"}' 2>/dev/null || echo "000")
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

python3 - "$ARTIFACT" "$PRIMARY_PROVIDER" "$PRIMARY_MODEL" > "$LOGS/prompt-request.json" <<'PY'
import json, sys
path, provider, model = sys.argv[1], sys.argv[2], sys.argv[3]
text = (
    "If you can run, use the write tool to create the file %s with the exact content OK. "
    "You must use the write tool, not bash. After the tool succeeds, reply with the single word DONE." % path
)
print(json.dumps({
    "model": {"providerID": provider, "modelID": model},
    "parts": [{"type": "text", "text": text}],
}))
PY

# The pinned route is a loopback closed port: the provider call is connection-
# refused. Connection errors are retryable, so allow a generous bound for the
# bounded retry schedule before the turn settles as an explicit failure.
prompt_status=$(curl -sS --max-time 300 -o "$LOGS/prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/prompt-request.json" 2>/dev/null || echo "000")
say "PROMPT pinned=$PRIMARY_PROVIDER/$PRIMARY_MODEL http=$prompt_status (unreachable route; expect explicit failure)"

# ---------------------------------------------------------------------------
# 3. Poll for a settled assistant message.
# ---------------------------------------------------------------------------
deadline=$((SECONDS + 300))
while :; do
  curl -sS --max-time 10 "$BASE/session/$SID/message?limit=50" \
    -H "Authorization: $AUTH" -o "$LOGS/messages.json" 2>/dev/null || true
  python3 "$RUN/parse_messages.py" "$LOGS/messages.json" > "$LOGS/assistant.env" 2>/dev/null || true
  state=$(grep '^STATE=' "$LOGS/assistant.env" 2>/dev/null | cut -d= -f2- || true)
  [ "$state" = "done" ] && break
  [ "$state" = "badjson" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 3
done

getval() { grep "^$1=" "$LOGS/assistant.env" 2>/dev/null | head -n1 | cut -d= -f2- || true; }
STATE=$(getval STATE)
COST=$(getval COST)
ERROR=$(getval ERROR)
ERROR_PRESENT=$(getval ERROR_PRESENT)
PROVIDER=$(getval PROVIDER)
MODEL=$(getval MODEL)
TEXT=$(getval TEXT)
TEXTPARTS=$(getval TEXTPARTS)

# ---------------------------------------------------------------------------
# 3a. EXPLICIT failure: the turn must settle and surface an error -- never a
#     silent hang, never a fake success.
# ---------------------------------------------------------------------------
[ "$STATE" = "done" ] || fail explicit-failure "assistant never settled (state=${STATE:-none}); a silent hang is a fail-closed violation"
[ "$ERROR_PRESENT" = "yes" ] || fail explicit-failure "expected an EXPLICIT surfaced error on the unreachable route, got none (text=${TEXT:-})"
say "EVIDENCE explicit_failure=true error=$(printf '%s' "$ERROR" | cut -c1-300)"

# ---------------------------------------------------------------------------
# 3b. NO hidden fallback: the failed route must not silently succeed via another
#     model/provider/route. The decoy is the only alternate; proving it was never
#     selected (and the pinned route identity was recorded) proves no fallback.
# ---------------------------------------------------------------------------
case "$PROVIDER" in
  ""|"$PRIMARY_PROVIDER") : ;;
  *) fail no-fallback "alternate/unexpected PROVIDER selected: $PROVIDER (pinned=$PRIMARY_PROVIDER, decoy=$DECOY_PROVIDER)" ;;
esac
case "$MODEL" in
  ""|"$PRIMARY_MODEL") : ;;
  *) fail no-fallback "alternate/unexpected MODEL selected: $MODEL (pinned=$PRIMARY_MODEL, decoy=$DECOY_MODEL)" ;;
esac
[ "$PROVIDER" != "$DECOY_PROVIDER" ] || fail no-fallback "decoy provider $DECOY_PROVIDER was selected: hidden fallback"
[ "$MODEL" != "$DECOY_MODEL" ] || fail no-fallback "decoy model $DECOY_MODEL was selected: hidden fallback"
say "EVIDENCE no_fallback=true recorded_provider=${PROVIDER:-unset} recorded_model=${MODEL:-unset} decoy=$DECOY_PROVIDER/$DECOY_MODEL not_selected=true"

# ---------------------------------------------------------------------------
# 3c. Fail-closed: never cost>0, never a successful completion, no artifact.
# ---------------------------------------------------------------------------
python3 - "$COST" <<'PY' > "$LOGS/cost.env" 2>/dev/null || true
import sys
raw = (sys.argv[1] or "").strip().lower()
ok = raw in ("", "null", "none", "0", "0.0", "0.00")
try:
    ok = ok or (float(raw) == 0.0)
except Exception:
    pass
print("COST_ZERO=%s" % ("yes" if ok else "no"))
PY
COST_ZERO=$(grep '^COST_ZERO=' "$LOGS/cost.env" 2>/dev/null | cut -d= -f2- || true)
[ "$COST_ZERO" = "yes" ] || fail cost "reported cost must stay 0 on the failed route, got ${COST:-missing}"

if [ -e "$ARTIFACT" ]; then
  ARTIFACT_PRESENT="yes"
  fail fail-closed "the failed turn created a partial-success artifact: $ARTIFACT"
else
  ARTIFACT_PRESENT="no"
fi

# A successful completion via ANY route is a fail-closed violation: there must be
# no assistant result body pretending the unreachable turn worked.
if [ "${TEXTPARTS:-0}" -gt 0 ] && [ -n "$TEXT" ]; then
  case "$TEXT" in
    *DONE*|*OK*) fail fail-closed "unreachable turn produced a success-looking result body: $TEXT" ;;
  esac
fi

say "E2E_V1_ROUTING_NEGATIVE=PASS"
say "EVIDENCE health=ok base=$BASE"
say "EVIDENCE ports primary_closed=$PORTA decoy_closed=$PORTB (loopback connect refused; zero egress)"
say "EVIDENCE providers primary=$PRIMARY_PROVIDER/$PRIMARY_MODEL decoy=$DECOY_PROVIDER/$DECOY_MODEL both_unreachable=true"
say "EVIDENCE session=$SID assistant=$STATE explicit_error=true no_fallback=true"
say "EVIDENCE cost=${COST:-0} artifact_created=false models_fetch=disabled catalog=repo-fixture"
say "LOGS=$LOGS"
exit 0
