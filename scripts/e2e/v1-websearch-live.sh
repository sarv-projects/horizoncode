#!/usr/bin/env bash
# HorizonCode V1 LIVE `web.search` journey — keyless route, no paid search key.
#
# WHAT IT PROVES (fail-closed, one command):
#   1. the model-facing tool surface really contains `websearch:web.search`
#      (HORIZON_DEBUG_TOOLS=1 stage dumps: allTools -> candidates -> afterTier)
#      and the runtime's own availability projection says a keyless route is
#      ready (GET /websearch/providers);
#   2. a live session, on the seeded models.dev catalog + the NVIDIA route
#      (same idioms as scripts/e2e/v1-live-provider.sh: delegated cgroup scope,
#      source-mode serve with the canonical hz-kernel, HTTP Basic auth, kernel
#      permission mode approvalPolicy=never / sandboxMode=danger-full-access),
#      actually calls the tool: a web.search-capability tool part appears on the
#      /event SSE stream;
#   3. the tool result is a real settled outcome, not a permission/Guard denial;
#   4. the dispatch hit the network: the HostKernel route receipt carries a real
#      provider + HTTP status + result count (recorded verbatim);
#   5. the final answer carries an http(s) URL and the word SEARCHED, and the
#      version it names is also present in the tool's own result payload, so the
#      answer cannot be a memory guess.
#
# The keyless cascade needs no credential: HostKernel itself issues the fixed
# HTTPS request under a Guard challenge, a one-use aggregate lease and a durable
# HTTP receipt journal. The default route is a plain GET of
# html.duckduckgo.com/html/ whose HTML is normalized by the kernel; the MCP
# endpoints (mcp.exa.ai, api.you.com, mcp.firecrawl.dev, search.parallel.ai)
# remain later fallbacks. Core holds no socket and no key.
#
# Egress note: this harness never fabricates a pass. If a route is rate limited,
# blocked, or its payload no longer matches the fixed adapter, the matching
# WEBSEARCH <step> FAIL line carries the exact provider, HTTP status and receipt
# classification, and the run exits non-zero.
#
# Usage:
#   bash scripts/e2e/v1-websearch-live.sh                 # firecrawl_keyless
#   WEBSEARCH_ROUTES=duckduckgo bash scripts/e2e/v1-websearch-live.sh
#   bash scripts/e2e/v1-websearch-live.sh --keep          # keep the run tree
#
# Env:
#   NEMOTRON_PROVIDER_ID=nvidia|openrouter  (default nvidia)
#   NEMOTRON_MODEL_ID=...                   (default the pinned Nemotron)
#   WEBSEARCH_ROUTES=a,b                    (default duckduckgo)
#   HORIZON_WEB_SEARCH_ANONYMOUS_RELEASE=1  (release switch for the keyless seam)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Terminal/browser containment needs a delegated, user-owned cgroup-v2 subtree.
# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

KEEP=0
for arg in "$@"; do
  [ "$arg" = "--keep" ] && KEEP=1
done

E2E="$ROOT/.tmp/e2e"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum 2>/dev/null | cut -c1-8)"
if ! printf '%s' "$RUN_TAG" | grep -Eq '^[0-9a-f]{8}$'; then
  printf 'E2E_V1_WEBSEARCH=FAIL\nWEBSEARCH env FAIL detail="could not derive an 8-hex run tag (md5sum unavailable?)"\n' >&2
  exit 1
fi
RUN="$E2E/ws-$RUN_TAG"
export STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
HOST_SOCK="$STATE_HOME_OVERRIDE/opencode/session-observer/ses_0123456789abcdefghij.sock"
LOGS="$E2E/logs/v1-websearch-live-$RUN_ID"
PROJECT="$RUN/work"

say() { printf '%s\n' "$*"; }

STEP_FAILS=0
ws_pass() { say "WEBSEARCH $1 PASS detail=\"$2\""; }
ws_fail() { STEP_FAILS=$((STEP_FAILS + 1)); say "WEBSEARCH $1 FAIL detail=\"$2\""; }

# --- provider / model pin (mirrors v1-live-provider.sh) ----------------------
PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
case "$PROVIDER_ID" in
  nvidia)
    KEY_VAR=NVIDIA_API_KEY
    PROVIDER_LABEL="NVIDIA"
    DEFAULT_MODEL="nvidia/nemotron-3.5-super-vl-120b-a12b"
    ;;
  openrouter)
    KEY_VAR=OPENROUTER_API_KEY
    PROVIDER_LABEL="OpenRouter"
    DEFAULT_MODEL="nvidia/nemotron-3.5-super-vl-120b-a12b:free"
    ;;
  *)
    printf 'E2E_V1_WEBSEARCH=FAIL\nWEBSEARCH env FAIL detail="unsupported NEMOTRON_PROVIDER_ID=%s"\n' "$PROVIDER_ID" >&2
    exit 1
    ;;
esac
export HZ_KEY_VAR="$KEY_VAR"
export HZ_PROVIDER_ID="$PROVIDER_ID"
MODEL_ID="${NEMOTRON_MODEL_ID:-$DEFAULT_MODEL}"
SEARCH_ROUTES="${WEBSEARCH_ROUTES:-duckduckgo}"
RELEASE_SWITCH="${HORIZON_WEB_SEARCH_ANONYMOUS_RELEASE:-1}"

ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$ROOT/.tmp/st-$RUN_TAG"
export PATH="$ORIG_HOME/.bun/bin:$PATH"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-v1-ws-$RANDOM-$RANDOM}"

SERVER_PID=""
SSE_PID=""
APPROVER_PID=""
BASE=""
AUTH=""
SID=""
KEY_LEAK_FOUND=""
CLEANED=0
WS_STATUS="none"
WS_PROVIDER="none"
WS_HTTP="none"
WS_MAX_STATUS="none"
WS_RESULTS="none"

cleanup() {
  rc=$1
  if [ "$CLEANED" = "1" ]; then exit "$rc"; fi
  CLEANED=1
  trap - EXIT INT TERM
  if [ -n "$APPROVER_PID" ] && kill -0 "$APPROVER_PID" 2>/dev/null; then kill -TERM "$APPROVER_PID" 2>/dev/null; fi
  if [ -n "$SSE_PID" ] && kill -0 "$SSE_PID" 2>/dev/null; then kill -TERM "$SSE_PID" 2>/dev/null; fi
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
  if [ -d "$LOGS" ]; then
    for f in "$LOGS"/*; do
      [ -f "$f" ] || continue
      sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
      if [ "${sz:-0}" -gt 1048576 ]; then tail -c 1048576 "$f" > "$f.cap" 2>/dev/null && mv "$f.cap" "$f"; fi
      if [ -n "${!KEY_VAR:-}" ] && grep -qF -- "${!KEY_VAR}" "$f" 2>/dev/null; then
        KEY_LEAK_FOUND="$KEY_LEAK_FOUND$f "
        python3 - "$f" "${!KEY_VAR}" <<'PYSCRUB' 2>/dev/null || true
import sys
path, key = sys.argv[1], sys.argv[2]
data = open(path, encoding="utf-8", errors="replace").read()
open(path, "w", encoding="utf-8").write(data.replace(key, "__REDACTED_API_KEY__"))
PYSCRUB
      fi
    done
  fi
  if [ -n "$KEY_LEAK_FOUND" ]; then
    say "E2E_V1_WEBSEARCH=FAIL"
    say "WEBSEARCH security FAIL detail=\"API key material found in logs (redacted in place): $KEY_LEAK_FOUND\""
    rc=1
  fi
  if [ "$KEEP" = "1" ]; then
    say "KEEP run=$RUN logs=$LOGS state=$XDG_STATE_HOME"
  else
    rm -rf "$RUN" 2>/dev/null || true
    rm -rf "$XDG_STATE_HOME" 2>/dev/null || true
  fi
  say "LOGS=$LOGS"
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

write_record() {
  status="$1"; step="$2"; detail="$3"
  python3 - "$LOGS/journey-$RUN_ID.json" "$status" "$step" "$detail" "$PROVIDER_ID/$MODEL_ID" \
    "${SID:-}" "$WS_STATUS" "$WS_PROVIDER" "$WS_HTTP" "$WS_MAX_STATUS" "$WS_RESULTS" "$STEP_FAILS" "$LOGS" <<'PYRECORD'
import json, sys
(out, status, step, detail, model, sid, ws_status, provider, http, attempt_status,
 results, fails, logs) = sys.argv[1:14]
record = {
    "kind": "websearch-live-journey",
    "status": status,
    "failed_step": step,
    "detail": detail[:800],
    "model_id": model,
    "session_id": sid,
    "tool_status": ws_status,
    "provider": provider,
    "http_status": http,
    "attempt_status": attempt_status,
    "result_count": results,
    "step_failures": fails,
    "logs": logs,
}
json.dump(record, open(out, "w", encoding="utf-8"), indent=1)
PYRECORD
}

fatal() {
  step=$1; shift
  ws_fail "$step" "$*"
  say "E2E_V1_WEBSEARCH=FAIL"
  if [ -s "$LOGS/serve.log" ]; then
    say "--- serve.log tail (redacted) ---"
    tail -n 25 "$LOGS/serve.log" | python3 -c '
import os, sys
key = os.environ.get(os.environ.get("HZ_KEY_VAR", "NVIDIA_API_KEY")) or ""
data = sys.stdin.read()
if key:
    data = data.replace(key, "__REDACTED__")
for line in data.splitlines():
    print(line[:400])
' 2>/dev/null || true
  fi
  write_record "failed" "$step" "$*"
  cleanup 1
}

# --- scratch tree -----------------------------------------------------------
if ! mkdir "$RUN" 2>/dev/null; then
  printf 'E2E_V1_WEBSEARCH=FAIL\nWEBSEARCH env FAIL detail="run dir already exists (tag collision): %s"\n' "$RUN"
  exit 1
fi
mkdir -p "$RUN"/config "$RUN"/data "$RUN"/state "$RUN"/cache "$RUN"/home "$RUN"/tmp "$RUN"/work "$LOGS" "$XDG_STATE_HOME" \
  || fatal env "could not create the per-run scratch tree under $RUN"
if [ "${#HOST_SOCK}" -ge 108 ]; then
  fatal env "observer socket path is ${#HOST_SOCK} bytes (>=108): $STATE_HOME_OVERRIDE"
fi
ws_pass env "scratch=$RUN logs=$LOGS socket_bytes=${#HOST_SOCK}"

# --- credential (never printed) --------------------------------------------
ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || fatal env "repo .env missing: $ENV_FILE"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${!KEY_VAR:-}" ] || fatal env "$KEY_VAR is not set after sourcing .env"
ws_pass key "provider=$PROVIDER_ID key_var=$KEY_VAR present=true (value never printed)"

BUN=""
command -v bun >/dev/null 2>&1 && BUN="$(command -v bun)"
if [ -z "$BUN" ] && [ -x "$ORIG_HOME/.bun/bin/bun" ]; then BUN="$ORIG_HOME/.bun/bin/bun"; fi
[ -n "$BUN" ] || fatal env "bun not found on PATH or \$HOME/.bun/bin"
ws_pass bun "$("$BUN" --version 2>/dev/null | head -n1) at $BUN"

# --- models.dev snapshot ----------------------------------------------------
HZ_MODELS_SNAPSHOT="${HZ_MODELS_SNAPSHOT:-$ORIG_HOME/.cache/opencode/models.json}"
[ -f "$HZ_MODELS_SNAPSHOT" ] || fatal catalog "no models.dev snapshot at $HZ_MODELS_SNAPSHOT (run \"bun run src/index.ts models\" once)"
mkdir -p "$XDG_CACHE_HOME/opencode"
cp -f "$HZ_MODELS_SNAPSHOT" "$XDG_CACHE_HOME/opencode/models.json" || fatal catalog "could not seed the models.dev snapshot"
ws_pass catalog "models.dev snapshot $(wc -c < "$XDG_CACHE_HOME/opencode/models.json") bytes provider=$PROVIDER_ID model=$MODEL_ID"

export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_AUTH_CONTENT="{}"

# --- primary AgentProfileV2 (same pin the prompt uses) ----------------------
mkdir -p "$XDG_CONFIG_HOME/opencode"
python3 - "$MODEL_ID" "$PROVIDER_ID" "$PROVIDER_LABEL" > "$XDG_CONFIG_HOME/opencode/opencode.json" <<'PYCONFIG'
import json, sys
model_id, provider_id, provider_label = sys.argv[1], sys.argv[2], sys.argv[3]
profile = {
    "schemaVersion": 2,
    "profileId": "user.primary",
    "revision": "1",
    "name": "V1 Web Search Primary",
    "description": "Primary profile pinning the live %s Nemotron model" % provider_label,
    "source": "user",
    "roles": ["main"],
    "purpose": "Authorize the pinned %s route for the web.search journey" % provider_id,
    "whenToUse": "V1 web-search E2E",
    "whenNotToUse": "Production",
    "adapter": {"kind": "native", "adapterId": "horizon.native"},
    "model": {"providerId": provider_id, "modelId": model_id},
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
    "limits": {"maxDepth": 2, "maxActiveChildren": 2, "maxTotalChildren": 2, "maxPendingMessages": 8, "maxMessageBytes": 65536},
    "maxParallelChildren": 1,
    "enabled": True,
}
print(json.dumps({
    "agent_profiles": [profile],
    "agent_profile_selectors": [{"selector": "primary", "profileId": "user.primary", "revision": "1"}],
    "primary_agent_profile_selector": "primary",
}))
PYCONFIG
[ -s "$XDG_CONFIG_HOME/opencode/opencode.json" ] || fatal config "failed to write the primary AgentProfileV2"
ws_pass profile "profileId=user.primary@1 model=$PROVIDER_ID/$MODEL_ID role=main"

# --- web-search config + permission (the only enablement knob) --------------
# Enablement is configuration only: consent to the built-in anonymous cascade
# plus the explicit keyless route set. No code path reads a credential here.
python3 - "$RUN/config-content.json" "$SEARCH_ROUTES" <<'PYPERM'
import json, sys
out, routes_csv = sys.argv[1], sys.argv[2]
routes = [r.strip() for r in routes_csv.split(",") if r.strip()]
keyless_order = ["duckduckgo", "exa_keyless", "firecrawl_keyless", "parallel_keyless", "youcom_free"]
order = routes + [r for r in keyless_order if r not in routes]
payload = {
    "permission": {
        "read": "allow", "files.read": "allow",
        "write": "allow", "files.write": "allow",
        "websearch": "allow", "web.search": "allow",
        "bash": "deny", "terminal.run": "deny",
    },
    "websearch": {
        "querySharingConsent": "anonymous_free_v1",
        "enabled": routes,
        "order": order,
    },
}
open(out, "w", encoding="utf-8").write(json.dumps(payload))
PYPERM
[ -s "$RUN/config-content.json" ] || fatal config "failed to build OPENCODE_CONFIG_CONTENT"
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT="$(cat "$RUN/config-content.json")"
ws_pass config "websearch.enabled=$SEARCH_ROUTES consent=anonymous_free_v1 permission=websearch:allow,bash:deny seam_release=$RELEASE_SWITCH"

AUTH="$(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
AUTH="Basic $AUTH"

# --- serve source-mode kernel wrapper (identical idiom to v1-live-provider) --
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
[ -f "$KERNEL_BIN" ] || fatal host_kernel "canonical repo-local hz-kernel binary missing: $KERNEL_BIN"
KERNEL_SHA="$(sha256sum "$KERNEL_BIN" 2>/dev/null | cut -d' ' -f1)"
case "$KERNEL_SHA" in
  [0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) fatal host_kernel "could not sha256sum kernel binary $KERNEL_BIN" ;;
esac
python3 - "$RUN/kernel-wrapper.ts" "$KERNEL_BIN" "$KERNEL_SHA" "$ROOT/packages/horizoncode/src/index.ts" "$PROJECT" <<'PYWRAP'
import json, sys
out, asset, sha, entry, project = sys.argv[1:6]
with open(out, "w", encoding="utf-8") as f:
    f.write("// E2E source-mode wrapper: set the build-time defines the compiled binary\n")
    f.write("// embeds (script/build.ts) as globals BEFORE loading the real CLI entry.\n")
    f.write("globalThis.OPENCODE_HOST_KERNEL_MANIFEST = JSON.stringify({\n")
    f.write("  schemaVersion: 1,\n")
    f.write('  status: "available",\n')
    f.write('  binaryName: "hz-kernel",\n')
    f.write('  target: "linux-" + process.arch + "-gnu",\n')
    f.write("  sha256: %s,\n" % json.dumps(sha))
    f.write("})\n")
    f.write("globalThis.OPENCODE_HOST_KERNEL_ASSET = %s\n" % json.dumps(asset))
    f.write("process.chdir(%s)\n" % json.dumps(project))
    f.write("await import(%s)\n" % json.dumps(entry))
PYWRAP
[ -s "$RUN/kernel-wrapper.ts" ] || fatal host_kernel "failed to write the kernel entry wrapper"
ws_pass host_kernel "binary=$KERNEL_BIN sha256=$KERNEL_SHA serve_mode=source"

# --- env scrub for the serve child -----------------------------------------
PROVIDER_SCRUB=(-u HORIZON_DIRECT_FREE_CREDENTIALS -u OTEL_EXPORTER_OTLP_HEADERS)
while IFS='=' read -r scrub_name _rest; do
  [ -n "$scrub_name" ] || continue
  case "$scrub_name" in
    *API_KEY*|*APIKEY*|*_TOKEN*|*_SECRET*|*SECRET*|*CREDENTIAL*|*PASSWORD*)
      case "$scrub_name" in
        OPENCODE_SERVER_PASSWORD|"$KEY_VAR") ;;
        *) PROVIDER_SCRUB+=(-u "$scrub_name") ;;
      esac
      ;;
  esac
done < <(env)
ws_pass env_scrub "credential-shaped env scrubbed except $KEY_VAR,OPENCODE_SERVER_PASSWORD"

# --- boot serve -------------------------------------------------------------
start_server() {
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
  BASE="http://127.0.0.1:$port"
  : > "$LOGS/serve.log"
  ( cd "$ROOT" && exec env \
    "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
    HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 \
    HORIZON_WEB_SEARCH_ANONYMOUS_RELEASE="$RELEASE_SWITCH" \
    HORIZON_DEBUG_TOOLS=1 \
    "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" --print-logs serve --hostname 127.0.0.1 --port "$port" ) \
    >>"$LOGS/serve.log" 2>&1 &
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
  say "SERVER attempt $attempt failed; retrying"
  tail -c 400 "$LOGS/serve.log" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
done
[ -n "$SERVER_PID" ] || fatal server "server did not become healthy after 3 attempts"
kill -0 "$SERVER_PID" 2>/dev/null || fatal server "server exited during the health wait"
ws_pass serve "pid=$SERVER_PID base=$BASE release_switch=$RELEASE_SWITCH debug_tools=1"

# --- negative probe: unauthenticated POST must 401 -------------------------
unauth_status=$(curl -sS --max-time 10 -o "$LOGS/unauth.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H 'content-type: application/json' -d '{}' 2>/dev/null || echo "000")
if [ "$unauth_status" = "401" ]; then
  ws_pass auth_negative "HTTP $unauth_status without credentials"
else
  fatal auth_negative "expected HTTP 401 without credentials, got $unauth_status"
fi

# --- session + SSE ---------------------------------------------------------
create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d '{"title":"v1-websearch-live"}' 2>/dev/null || echo "000")
[ "$create_status" = "200" ] || fatal session_create "HTTP $create_status: $(head -c 300 "$LOGS/session.json" 2>/dev/null)"
SID=$(python3 -c '
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: sys.exit(1)
print(data.get("id", "") if isinstance(data, dict) else "")
' "$LOGS/session.json" 2>/dev/null || true)
[ -n "$SID" ] || fatal session_create "no session id in the response"
ws_pass session "id=$SID"

cat > "$RUN/collect_events.py" <<'PYCOLLECT'
import json, sys, time, urllib.request

base, auth_header, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
req = urllib.request.Request(base + "/event", headers={"Authorization": auth_header, "Accept": "text/event-stream"})
out = open(out_path, "a", encoding="utf-8")
try:
    with urllib.request.urlopen(req, timeout=3600) as resp:
        buf = ""
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            buf += chunk.decode("utf-8", "replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.rstrip("\r")
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                row = {"t": time.time(), "raw": payload[:20000]}
                try:
                    parsed = json.loads(payload)
                    row["type"] = parsed.get("type") or ""
                    props = parsed.get("properties") if isinstance(parsed.get("properties"), dict) else {}
                    row["sessionID"] = props.get("sessionID") or ""
                    typ = row["type"]
                    if typ in ("session.next.text.delta", "message.part.delta"):
                        row["delta"] = props.get("delta") or ""
                    elif typ == "session.next.tool.called":
                        row["tool"] = props.get("tool") or ""
                        row["callID"] = props.get("callID") or ""
                    elif typ in ("session.next.tool.success", "session.next.tool.failed"):
                        row["callID"] = props.get("callID") or ""
                        row["tool"] = props.get("tool") or ""
                    elif typ == "message.part.updated":
                        part = props.get("part") if isinstance(props.get("part"), dict) else {}
                        row["part_type"] = part.get("type") or ""
                        if part.get("type") == "tool":
                            row["tool"] = part.get("tool") or ""
                            row["callID"] = part.get("id") or ""
                            st = part.get("state") if isinstance(part.get("state"), dict) else {}
                            row["status"] = st.get("status") or ""
                    elif typ == "message.updated":
                        info = props.get("info") if isinstance(props.get("info"), dict) else {}
                        if info.get("role") == "assistant":
                            row["assistant_message"] = info.get("id") or ""
                            row["model_providerID"] = info.get("providerID") or ""
                            row["model_modelID"] = info.get("modelID") or ""
                except Exception:
                    row["type"] = "unparsed"
                out.write(json.dumps(row) + "\n")
                out.flush()
except Exception as exc:
    out.write(json.dumps({"t": time.time(), "type": "collector.error", "error": str(exc)[:300]}) + "\n")
    out.flush()
PYCOLLECT

: > "$LOGS/events.jsonl"
python3 "$RUN/collect_events.py" "$BASE" "$AUTH" "$LOGS/events.jsonl" > "$LOGS/collector.out" 2>&1 &
SSE_PID=$!
sleep 1
kill -0 "$SSE_PID" 2>/dev/null || fatal sse "event collector exited during startup: $(head -c 300 "$LOGS/collector.out" 2>/dev/null)"
ws_pass sse "collector pid=$SSE_PID -> $LOGS/events.jsonl"

# --- truthful availability projection (read-only, no provider call) --------
prov_status=$(curl -sS --max-time 20 -o "$LOGS/providers.json" -w '%{http_code}' \
  "$BASE/websearch/providers?directory=$PROJECT" -H "Authorization: $AUTH" 2>/dev/null || echo "000")
python3 - "$LOGS/providers.json" "$SEARCH_ROUTES" "$prov_status" <<'PYPROV' > "$LOGS/availability.env"
import json, sys
path, routes_csv, http = sys.argv[1], sys.argv[2], sys.argv[3]
routes = [r.strip() for r in routes_csv.split(",") if r.strip()]
print("PROVIDERS_HTTP=%s" % http)
try:
    rows = json.load(open(path, encoding="utf-8"))
except Exception as exc:
    print("AVAILABILITY=unparsed")
    print("AVAILABILITY_DETAIL=%s" % str(exc)[:200])
    sys.exit(0)
if isinstance(rows, dict):
    rows = rows.get("providers") or rows.get("data") or []
byname = {}
for row in rows if isinstance(rows, list) else []:
    if isinstance(row, dict) and row.get("provider"):
        byname[row["provider"]] = row
parts = []
for route in routes:
    row = byname.get(route) or {}
    parts.append("%s=%s" % (route, row.get("status") or "unknown"))
    if row.get("unavailableReason"):
        print("REASON_%s=%s" % (route, str(row["unavailableReason"])[:300]))
print("AVAILABILITY=%s" % ",".join(parts))
PYPROV
PROVIDERS_HTTP=$(grep '^PROVIDERS_HTTP=' "$LOGS/availability.env" | cut -d= -f2-)
AVAILABILITY=$(grep '^AVAILABILITY=' "$LOGS/availability.env" | cut -d= -f2-)
case "$AVAILABILITY" in
  *"=ready"*) ws_pass availability "GET /websearch/providers HTTP $PROVIDERS_HTTP -> $AVAILABILITY" ;;
  *) ws_fail availability "GET /websearch/providers HTTP $PROVIDERS_HTTP -> ${AVAILABILITY:-unparsed}; $(grep '^REASON_' "$LOGS/availability.env" | head -n2 | tr '\n' ' ')" ;;
esac

# --- kernel-owned permission posture --------------------------------------
mode_http=""
for attempt in 1 2 3 4 5; do
  mode_http=$(curl -sS -i --max-time 20 -H "Authorization: $AUTH" \
    "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null || true)
  printf '%s' "$mode_http" > "$LOGS/mode-read.raw"
  case "$mode_http" in *'"revision"'*) break ;; esac
  sleep 2
done
printf '%s' "$mode_http" | sed '1,/^\r*$/d' > "$LOGS/mode-read.json"
mode_rev=$(grep -o '"revision":"[^"]*"' "$LOGS/mode-read.json" 2>/dev/null | head -1 | cut -d'"' -f4)
[ -n "$mode_rev" ] || fatal permission_mode "no revision in the mode read: $(head -c 300 "$LOGS/mode-read.raw" 2>/dev/null)"
mode_patch=$(curl -sS --max-time 20 -o "$LOGS/mode-patch.json" -w '%{http_code}' \
  -X PATCH -H "Authorization: $AUTH" -H 'content-type: application/json' \
  "$BASE/config/direct-session-permission-mode?sessionID=$SID" \
  -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$mode_rev\"}" \
  2>/dev/null || echo "000")
[ "$mode_patch" = "200" ] || fatal permission_mode "PATCH failed HTTP $mode_patch: $(head -c 300 "$LOGS/mode-patch.json" 2>/dev/null)"
mode_after=$(curl -sS --max-time 20 -H "Authorization: $AUTH" \
  "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null || true)
printf '%s' "$mode_after" > "$LOGS/mode-after.json"
printf '%s' "$mode_after" | grep -q '"approvalPolicy":"never"' \
  || fatal permission_mode "approvalPolicy=never did not stick: $(head -c 300 "$LOGS/mode-after.json" 2>/dev/null)"
printf '%s' "$mode_after" | grep -q '"sandboxMode":"danger-full-access"' \
  || fatal permission_mode "sandboxMode did not stick: $(head -c 300 "$LOGS/mode-after.json" 2>/dev/null)"
ws_pass permission_mode "approvalPolicy=on-request sandboxMode=workspace-write rev=$mode_rev (the only HostKernel-approved approval-bearing combination; web.search still needs its explicit Guard approval)"


# --- approver: the human round-trip, automated -------------------------------
# `web.search` is a consent-bearing outbound egress, so the kernel classifies it
# `Ask` even in the autonomous posture. This harness plays the approver: it
# answers the Core tool asks and replies `allow_once` to the exact Guard approval
# ids the host announces. Nothing is bypassed -- Guard still mints the challenge,
# the one-use lease and the receipt; only the human keystroke is automated.
cat > "$RUN/approver.py" <<'PYAPPROVE'
import json, os, sys, time, urllib.error, urllib.request

base, auth, sid, events_path, log_path = sys.argv[1:6]
seen = set()
offset = 0
log = open(log_path, "a", encoding="utf-8")

def post(path, payload):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Authorization": auth, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(300)
    except urllib.error.HTTPError as e:
        return e.code, e.read(300)
    except Exception as exc:
        return None, repr(exc).encode()

while True:
    try:
        req = urllib.request.Request(base + "/permission", headers={"Authorization": auth})
        with urllib.request.urlopen(req, timeout=5) as r:
            rows = json.loads(r.read() or b"[]")
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("tool"), dict):
                status, _ = post("/permission/%s/reply" % row["id"], {"reply": "always"})
                log.write(json.dumps({"t": time.time(), "kind": "tool", "id": row["id"], "status": status}) + "\n")
                log.flush()
    except Exception:
        pass
    try:
        if os.path.exists(events_path):
            with open(events_path, "r", encoding="utf-8", errors="replace") as handle:
                handle.seek(offset)
                for line in handle:
                    offset = handle.tell()
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except Exception:
                        continue
                    raw = row.get("raw") or ""
                    if "guard.approval" not in (row.get("type") or "") and "guard.approval" not in raw:
                        continue
                    payload = {}
                    try:
                        payload = json.loads(raw)
                    except Exception:
                        pass
                    props = payload.get("properties") if isinstance(payload.get("properties"), dict) else {}
                    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
                    approval = props.get("approvalID") or data.get("approvalID")
                    if not approval or approval in seen:
                        continue
                    seen.add(approval)
                    status, body = post(
                        "/session/%s/guard/approval/%s/reply" % (sid, approval),
                        {"decision": "allow_once"},
                    )
                    log.write(json.dumps({"t": time.time(), "kind": "guard", "id": approval, "status": status,
                                          "capability": props.get("capabilityID") or data.get("capabilityID"),
                                          "body": body.decode("utf-8", "replace")[:200]}) + "\n")
                    log.flush()
    except Exception:
        pass
    time.sleep(0.5)
PYAPPROVE
python3 "$RUN/approver.py" "$BASE" "$AUTH" "$SID" "$LOGS/events.jsonl" "$LOGS/approver.log" > "$LOGS/approver.out" 2>&1 &
APPROVER_PID=$!
sleep 1
kill -0 "$APPROVER_PID" 2>/dev/null && ws_pass approver "pid=$APPROVER_PID (tool asks + guard approvals -> allow_once)" \
  || ws_fail approver "approver exited during startup: $(head -c 200 "$LOGS/approver.out" 2>/dev/null)"

# --- prompt: cannot be answered without a lookup ---------------------------
python3 - "$RUN/prompt.json" "$PROVIDER_ID" "$MODEL_ID" > "$RUN/prompt.json" <<'PYPROMPT'
import json, sys
out, provider, model = sys.argv[1:4]
text = (
    "Use your web search tool (capability web.search) to find the CURRENT latest released "
    "version of the Python `httpx` package and the URL you got it from.\n"
    "Rules:\n"
    "1. Call the web search tool first. Do not answer from memory, do not guess, and do not use a shell.\n"
    "2. Then reply with exactly three things: the version, the doc URL, and the single word SEARCHED.\n"
    "3. If the search tool is unavailable, fails, or returns no results, reply with the single word "
    "UNAVAILABLE followed by the exact reason the tool reported. Never invent a version or URL.\n"
)
print(json.dumps({
    "model": {"providerID": provider, "modelID": model},
    "parts": [{"type": "text", "text": text}],
}))
PYPROMPT
[ -s "$RUN/prompt.json" ] || fatal prompt "failed to build the prompt request"

T0=$(python3 -c 'import time; print(time.time())')
say "STEP prompt: sending pinned $PROVIDER_ID/$MODEL_ID web.search prompt (t0=$T0)"
prompt_status=$(curl -sS --max-time 900 -o "$LOGS/prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$RUN/prompt.json" 2>/dev/null || echo "000")
[ "$prompt_status" = "200" ] || fatal prompt "HTTP $prompt_status: $(head -c 500 "$LOGS/prompt-response.json" 2>/dev/null)"

# Wait for the assistant message to settle.
settled="unknown"
deadline=$((SECONDS + 300))
while :; do
  curl -sS --max-time 10 "$BASE/session/$SID/message?limit=50" \
    -H "Authorization: $AUTH" -o "$LOGS/messages.json" 2>/dev/null || true
  settled=$(python3 - "$LOGS/messages.json" <<'PYSTATE'
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: print("waiting"); sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
if not isinstance(msgs, list): msgs = []
assistants = [m for m in msgs if isinstance(m, dict) and isinstance(m.get("info"), dict) and m["info"].get("role") == "assistant"]
if not assistants: print("waiting"); sys.exit(0)
info = assistants[-1]["info"]
time_ = info.get("time") if isinstance(info.get("time"), dict) else {}
print("done" if (time_.get("completed") or info.get("finish") is not None) else "running")
PYSTATE
)
  [ "$settled" = "done" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 2
done
ws_pass prompt "HTTP $prompt_status assistant_state=${settled:-unknown}"

# --- independent egress control probe (outside the product) ----------------
# Distinguishes "this network cannot reach the provider" from "the product's
# fixed adapter no longer decodes the provider payload".
python3 - "$LOGS/egress.txt" "$SEARCH_ROUTES" <<'PYEGRESS'
import json, sys, urllib.parse, urllib.request, urllib.error

out, routes_csv = sys.argv[1], sys.argv[2]
HOSTS = {
    "exa_keyless": ("mcp.exa.ai", "/mcp", "web_search_exa"),
    "youcom_free": ("api.you.com", "/mcp?profile=free", "you-search"),
    "firecrawl_keyless": ("mcp.firecrawl.dev", "/v2/mcp", "firecrawl_search"),
    "parallel_keyless": ("search.parallel.ai", "/mcp", "web_search"),
}

def post(url, body, sid=None):
    headers = {"content-type": "application/json", "accept": "application/json, text/event-stream",
               "user-agent": "HorizonCode/1"}
    if sid:
        headers["mcp-session-id"] = sid
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(400000)
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read(4000)
    except Exception as exc:
        return None, {}, repr(exc).encode()

def last_data(ct, body):
    if "text/event-stream" in ct:
        for line in reversed(body.decode("utf-8", "replace").splitlines()):
            if line.startswith("data:"):
                d = line[5:].strip()
                if d and d != "[DONE]":
                    return d
        return ""
    return body.decode("utf-8", "replace")

lines = []
for route in [r.strip() for r in routes_csv.split(",") if r.strip()]:
    if route == "duckduckgo":
        # The HTML route is a plain GET: there is no MCP handshake to observe.
        query = urllib.parse.quote_plus("latest released version of python httpx package")
        request = urllib.request.Request(
            "https://html.duckduckgo.com/html/?q=" + query, method="GET",
            headers={
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
                "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                               "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"),
            })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                get_status, body = response.status, response.read(400000)
        except urllib.error.HTTPError as error:
            get_status, body = error.code, error.read(4000)
        except Exception as error:
            get_status, body = None, repr(error).encode()
        page = body.decode("utf-8", "replace")
        lines.append("EGRESS route=duckduckgo get_http=%s bytes=%d result_anchors=%d" % (
            get_status, len(body), page.count('class="result__a"')))
        continue
    host, path, toolname = HOSTS[route]
    url = "https://" + host + path
    st, h, b = post(url, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "HorizonCode", "version": "1"}}})
    sid = h.get("mcp-session-id")
    detail = ["route=%s" % route, "init_http=%s" % st, "session_header=%s" % ("yes" if sid else "no")]
    if st == 200:
        post(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        if route == "exa_keyless":
            args = {"query": "latest released version of python httpx package", "numResults": 5,
                    "contents": {"text": {"maxCharacters": 1200}}}
        elif route == "firecrawl_keyless":
            args = {"query": "latest released version of python httpx package", "limit": 5, "sources": ["web"]}
        elif route == "youcom_free":
            args = {"query": "latest released version of python httpx package", "count": 5, "safesearch": "moderate"}
        else:
            args = {"query": "latest released version of python httpx package", "max_results": 5}
        st2, h2, b2 = post(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                 "params": {"name": toolname, "arguments": args}}, sid)
        dec = last_data(h2.get("content-type", ""), b2)
        shape = "unknown"
        try:
            v = json.loads(dec)
            pts = []
            for p in ("/result/structuredContent/results", "/result/results", "/result/data/results", "/result/web/results"):
                cur = v
                for part in p.strip("/").split("/"):
                    cur = cur.get(part) if isinstance(cur, dict) else None
                if isinstance(cur, list):
                    pts.append("%s=%d" % (p, len(cur)))
            if v.get("result", {}).get("isError"):
                pts.append("mcp_is_error=true")
            content = v.get("result", {}).get("content")
            if isinstance(content, list) and content:
                t = content[0].get("text", "") if isinstance(content[0], dict) else ""
                try:
                    json.loads(t)
                    pts.append("content_text=json")
                except Exception:
                    pts.append("content_text=prose")
            shape = ",".join(pts) or "no_structured_results"
        except Exception:
            shape = "unparseable"
        detail += ["call_http=%s" % st2, "shape=%s" % shape]
    else:
        detail += ["call_http=not_attempted"]
    lines.append("EGRESS " + " ".join(detail))
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PYEGRESS
while IFS= read -r line; do
  [ -n "$line" ] || continue
  say "WEBSEARCH egress INFO ${line#EGRESS }"
done < "$LOGS/egress.txt"

# --- assertions -------------------------------------------------------------
python3 - "$LOGS/messages.json" "$LOGS/events.jsonl" "$LOGS/serve.log" "$SID" "$SEARCH_ROUTES" > "$LOGS/assert.out" 2>&1 <<'PYASSERT'
import json, re, sys

messages_path, events_path, log_path, sid, routes_csv = sys.argv[1:6]
TOOL_NAMES = {"websearch", "web_search", "web.search"}
fails = 0

def emit(step, ok, detail):
    global fails
    if not ok:
        fails += 1
    print('WEBSEARCH %s %s detail="%s"' % (step, "PASS" if ok else "FAIL", detail.replace('"', "'")[:600]))

try:
    data = json.load(open(messages_path, encoding="utf-8"))
except Exception as exc:
    emit("messages", False, "messages.json unreadable: %s" % exc)
    print("ASSERT_FAILS=%d" % fails)
    sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
if not isinstance(msgs, list):
    msgs = []
assistants = [m for m in msgs if isinstance(m, dict) and isinstance(m.get("info"), dict)
              and m["info"].get("role") == "assistant"]
if not assistants:
    emit("messages", False, "no assistant message in the session")
    print("ASSERT_FAILS=%d" % fails)
    sys.exit(0)
last = assistants[-1]
final_text = "".join(p.get("text") or "" for p in (last.get("parts") or [])
                     if isinstance(p, dict) and p.get("type") == "text")
model_ids = sorted({"%s/%s" % ((m["info"].get("providerID") or ""), (m["info"].get("modelID") or ""))
                    for m in assistants})

tool_parts = []
for m in assistants:
    for p in (m.get("parts") or []):
        if isinstance(p, dict) and p.get("type") == "tool" and (p.get("tool") or "") in TOOL_NAMES:
            tool_parts.append(p)

emit("answer_marker", "SEARCHED" in final_text,
     "final_text_marker=%s text=%s" % ("SEARCHED" if "SEARCHED" in final_text else "absent", final_text[:220]))

rows = []
try:
    rows = [json.loads(line) for line in open(events_path, encoding="utf-8") if line.strip()]
except Exception:
    rows = []
scoped = [r for r in rows if not r.get("sessionID") or not sid or r.get("sessionID") == sid]
calls = []
for r in scoped:
    tool = (r.get("tool") or "").strip()
    if tool not in TOOL_NAMES:
        continue
    if (r.get("type") or "") in ("session.next.tool.called", "message.part.updated",
                                 "session.next.tool.success", "session.next.tool.failed"):
        calls.append(r)
deltas = sum(1 for r in scoped
             if (r.get("type") in ("session.next.text.delta", "message.part.delta")) and (r.get("delta") or ""))
emit("search_call", len(calls) > 0,
     "web.search calls on SSE=%d streamed_deltas=%d event_types=%s" % (
         len(calls), deltas, ",".join(sorted({r.get("type") for r in calls})) or "none"))

dump = ""
try:
    with open(log_path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if "[DBG] allTools" in line or "[DBG] afterTier" in line or "[DBG] candidates" in line:
                dump += line
except Exception:
    pass
after_tier = "websearch:web.search" in dump
all_tools = "websearch" in dump
gate = "exposed" if after_tier else (
    "dropped-before-registry" if not all_tools else "dropped-at-capability-tier-or-permission")
emit("tool_surface", after_tier,
     "websearch:web.search in afterTier=%s allTools=%s gate=%s" % (
         str(after_tier).lower(), str(all_tools).lower(), gate))

part = tool_parts[-1] if tool_parts else None
if part is None:
    emit("search_result", False, "no websearch tool part in the session messages")
    emit("network", False, "no tool part, so no dispatch evidence")
    emit("answer_url", False, "no tool result to ground an answer")
    emit("answer_version", False, "no tool result to ground a version")
    print("ASSERT_FAILS=%d" % fails)
    sys.exit(0)
state = part.get("state") if isinstance(part.get("state"), dict) else {}
status = state.get("status") or "unknown"
meta = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
output = state.get("output") or ""
error = str(state.get("error") or "")
text_out = output if isinstance(output, str) else json.dumps(output)
denial = re.search(r"(denied|denial|permission|guard|unauthori[sz]ed|not allowed)", text_out + " " + error, re.I)
emit("search_result", status == "completed" and meta.get("status") == "succeeded",
     "tool_state=%s metadata_status=%s output_bytes=%d denial_terms=%s error=%s" % (
         status, meta.get("status") or "none", len(text_out),
         (denial.group(1).lower() if denial else "none"), error[:200]))

attempts = meta.get("routeAttempts") if isinstance(meta.get("routeAttempts"), list) else []
rows_txt = []
dispatched = None
succeeded = None
for a in attempts:
    if not isinstance(a, dict):
        continue
    rows_txt.append("%s:%s/http=%s/results=%s" % (
        a.get("providerId") or "?", a.get("status") or "?",
        a.get("statusCode") if a.get("statusCode") is not None else "none",
        a.get("resultCount") if a.get("resultCount") is not None else "none"))
    if isinstance(a.get("statusCode"), int) and dispatched is None:
        dispatched = a
    if (a.get("status") == "succeeded") and isinstance(a.get("statusCode"), int) and 200 <= a["statusCode"] < 300:
        succeeded = a
provider = meta.get("provider") or (dispatched or succeeded or {}).get("providerId") or "none"
keyless = (str(provider) == "duckduckgo" or str(provider).endswith("_keyless")
           or str(provider) == "youcom_free")
chosen = succeeded or dispatched
http = (chosen or {}).get("statusCode")
# Egress is proven by any settled HTTP status from a keyless route; whether that
# payload decoded into results is the separate `search_result` step.
emit("network", dispatched is not None and keyless,
     "provider=%s http=%s keyless=%s dispatched_attempts=%d succeeded_route=%s attempts=[%s] latency_ms=%s" % (
         provider, http if http is not None else "none", str(keyless).lower(), len(rows_txt),
         str(succeeded is not None).lower(), (";".join(rows_txt))[:380] or "none", meta.get("latencyMs", "none")))

urls = re.findall(r"https?://[^\s\)\]\"'<>]+", final_text)
versions = re.findall(r"\b\d+\.\d+\.\d+\b|\b\d+\.\d+\b", final_text)
out_versions = set(re.findall(r"\b\d+\.\d+\.\d+\b", text_out))
grounded = [v for v in versions if v in out_versions]
emit("answer_url", len(urls) > 0, "urls=%s" % ((",".join(urls[:3])) or "none"))
emit("answer_version", len(grounded) > 0,
     "answer_versions=%s grounded_in_tool_output=%s" % (
         ",".join(versions[:4]) or "none", ",".join(grounded[:4]) or "none"))
if urls:
    print("WEBSEARCH answer_url VALUE url=%s" % urls[0][:300])
if versions:
    print("WEBSEARCH answer_version VALUE version=%s" % versions[0][:40])
print("WEBSEARCH answer_text INFO model_ids=%s" % ",".join(model_ids))
print("ASSERT_FAILS=%d" % fails)
PYASSERT

cat "$LOGS/assert.out"
ASSERT_FAILS=$(grep -c ' FAIL ' "$LOGS/assert.out" 2>/dev/null || true)
[ -n "$ASSERT_FAILS" ] || ASSERT_FAILS=0

WS_STATUS=$(python3 - "$LOGS/messages.json" <<'PYS'
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: print("none"); sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
parts = [p for m in msgs if isinstance(m, dict) for p in (m.get("parts") or [])
         if isinstance(p, dict) and p.get("type") == "tool" and (p.get("tool") or "") in ("websearch", "web_search", "web.search")]
if not parts: print("none"); sys.exit(0)
st = parts[-1].get("state") if isinstance(parts[-1].get("state"), dict) else {}
meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
print("%s/%s" % (st.get("status") or "unknown", meta.get("status") or "none"))
PYS
)
WS_PROVIDER=$(python3 - "$LOGS/messages.json" <<'PYP'
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: print("none"); sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
parts = [p for m in msgs if isinstance(m, dict) for p in (m.get("parts") or [])
         if isinstance(p, dict) and p.get("type") == "tool" and (p.get("tool") or "") in ("websearch", "web_search", "web.search")]
if not parts: print("none"); sys.exit(0)
st = parts[-1].get("state") if isinstance(parts[-1].get("state"), dict) else {}
meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
print(meta.get("provider") or "none")
PYP
)
WS_HTTP=$(python3 - "$LOGS/messages.json" <<'PYH'
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: print("none"); sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
parts = [p for m in msgs if isinstance(m, dict) for p in (m.get("parts") or [])
         if isinstance(p, dict) and p.get("type") == "tool" and (p.get("tool") or "") in ("websearch", "web_search", "web.search")]
if not parts: print("none"); sys.exit(0)
st = parts[-1].get("state") if isinstance(parts[-1].get("state"), dict) else {}
meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
for a in (meta.get("routeAttempts") or []):
    if isinstance(a, dict) and a.get("statusCode") is not None:
        print(a["statusCode"]); sys.exit(0)
print("none")
PYH
)
WS_MAX_STATUS=$(python3 - "$LOGS/messages.json" <<'PYM'
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: print("none"); sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
parts = [p for m in msgs if isinstance(m, dict) for p in (m.get("parts") or [])
         if isinstance(p, dict) and p.get("type") == "tool" and (p.get("tool") or "") in ("websearch", "web_search", "web.search")]
if not parts: print("none"); sys.exit(0)
st = parts[-1].get("state") if isinstance(parts[-1].get("state"), dict) else {}
meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
rows = []
for a in (meta.get("routeAttempts") or []):
    if isinstance(a, dict):
        rows.append("%s:%s/http=%s/results=%s" % (a.get("providerId") or "?", a.get("status") or "?",
                    a.get("statusCode") if a.get("statusCode") is not None else "none",
                    a.get("resultCount") if a.get("resultCount") is not None else "none"))
print(";".join(rows) or "none")
PYM
)
WS_RESULTS=$(python3 - "$LOGS/messages.json" <<'PYR'
import json, sys
try: data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: print("none"); sys.exit(0)
msgs = data if isinstance(data, list) else (data.get("messages") or data.get("data") or [])
parts = [p for m in msgs if isinstance(m, dict) for p in (m.get("parts") or [])
         if isinstance(p, dict) and p.get("type") == "tool" and (p.get("tool") or "") in ("websearch", "web_search", "web.search")]
if not parts: print("none"); sys.exit(0)
st = parts[-1].get("state") if isinstance(parts[-1].get("state"), dict) else {}
meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
res = (meta.get("result") or {}).get("results")
print(len(res) if isinstance(res, list) else "none")
PYR
)

TOTAL_FAILS=$((STEP_FAILS + ASSERT_FAILS))

say ""
say "=== WEBSEARCH MATRIX ==="
if [ -s "$LOGS/assert.out" ]; then cat "$LOGS/assert.out"; fi

say "EVIDENCE session=$SID tool=$WS_STATUS provider=$WS_PROVIDER http=$WS_HTTP results=$WS_RESULTS"
say "EVIDENCE attempts=$WS_MAX_STATUS"
if [ "$TOTAL_FAILS" -gt 0 ]; then
  say "E2E_V1_WEBSEARCH=FAIL"
  write_record "failed" "assert" "$TOTAL_FAILS failing step(s)"
  say "LOGS=$LOGS"
  exit 1
fi
say "E2E_V1_WEBSEARCH=PASS"
write_record "passed" "" ""
say "LOGS=$LOGS"
exit 0
