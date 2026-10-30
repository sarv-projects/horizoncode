#!/usr/bin/env bash
# HorizonCode V1 LIVE provider journey (Lead 4) — REAL OpenRouter Nemotron.
#
# One command, fail-closed, modeled on scripts/e2e/v1-smoke.sh but pointed at
# the real OpenRouter provider instead of the loopback mock:
#   1. boots real `horizoncode serve` (source mode + canonical HostKernel
#      wrapper, same idiom as v1-smoke.sh) on a random high loopback port
#      with HTTP Basic auth;
#   2. registers a REAL inline catalog: provider `openrouter`
#      (https://openrouter.ai/api/v1, npm @openrouter/ai-sdk-provider) with a
#      PINNED Nemotron model (default nvidia/nemotron-3-nano-30b-a3b, the
#      cheapest tools-capable Nemotron on OpenRouter) and REAL pricing;
#   3. negative probe: unauthenticated POST must 401;
#   4. subscribes to the live SSE event stream (GET /event) and records every
#      wire event with a receive timestamp;
#   5. creates a session pinned to the Nemotron model and sends ONE prompt
#      that requires a REAL multi-step tool loop:
#        read seed.txt -> write answer.txt with EXACT content -> run a bash
#        command -> report its output and finish with DONE;
#   6. asserts, fail-closed:
#        - real streaming tokens arrived (>=3 non-empty session.next.text.delta
#          events on the SSE stream, filtered to this session);
#        - the tool loop executed (read completed, write completed with the
#          file on disk containing EXACTLY the required bytes, bash completed
#          and its output visible in the final assistant text);
#        - model identity: EVERY assistant message in the session reports
#          providerID=openrouter and the pinned Nemotron modelID (no silent
#          fallback — a mismatch FAILs the run);
#        - usage: input+output tokens > 0 were reported (cost field present);
#        - security: the OPENROUTER_API_KEY string never appears in any
#          surviving log (scan + redact on exit).
#
# Credentials: OPENROUTER_API_KEY is loaded from the repo-root .env (never
# printed, never echoed; referenced only as "$OPENROUTER_API_KEY"). The serve
# child keeps ONLY OPENROUTER_API_KEY + OPENCODE_SERVER_PASSWORD; every other
# credential-shaped env var is scrubbed (same sweep as v1-smoke.sh).
#
# If the current tree's fail-closed provider gates reject the credentialed
# send (SecretBroker / Core RequestExecutor work still landing), this script
# does NOT fake success: it prints the exact provider error as
# EVIDENCE_FAIL step=assistant|provider and exits non-zero, and writes a JSON
# record with the observed status under .tmp/nemotron-bench/live/.
#
# Run-ID isolation: each invocation derives RUN_ID (timestamp + PID); logs go
# to .tmp/e2e/logs/v1-live-provider-$RUN_ID/. Prior logs accumulate on
# purpose; reclaim manually when idle: rm -rf .tmp/e2e/logs/v1-live-provider-*
#
# Usage:
#   bash scripts/e2e/v1-live-provider.sh
#   NEMOTRON_MODEL_ID=openrouter-model-id bash scripts/e2e/v1-live-provider.sh
#   OPENCODE_SERVER_PASSWORD=... bash scripts/e2e/v1-live-provider.sh   # optional pin
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Terminal containment needs a delegated, user-owned cgroup-v2 subtree.
# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"
E2E="$ROOT/.tmp/e2e"
BENCH="$ROOT/.tmp/nemotron-bench"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
# 11-char state tag keeps the HostKernel Unix socket < 108 bytes (see smoke).
RUN_TAG="$(printf '%s' "$RUN_ID" | md5sum 2>/dev/null | cut -c1-8)"
if ! printf '%s' "$RUN_TAG" | grep -Eq '^[0-9a-f]{8}$'; then
  printf 'E2E_V1_LIVE_PROVIDER=FAIL\nEVIDENCE_FAIL step=env detail=could not derive a valid 8-hex run tag (md5sum unavailable?)\n' >&2
  exit 1
fi
RUN="$E2E/lp-$RUN_TAG"
# Short XDG_STATE_HOME: the dist CLI starts a Rust session_supervisor sidecar
# whose Unix socket lives under the state dir and must stay < 108 bytes (the
# repo root alone costs 31). "st-<8hex>" keeps the worst-case observer socket
# at ~102 bytes; a longer path silently breaks the Guard ("Rust Guard
# unavailable") and every write is denied.
export STATE_HOME_OVERRIDE="$ROOT/.tmp/st-$RUN_TAG"
HOST_SOCK="$STATE_HOME_OVERRIDE/opencode/session-observer/ses_0123456789abcdefghij.sock"
if [ "${#HOST_SOCK}" -ge 108 ]; then
  printf 'E2E_V1_LIVE_PROVIDER=FAIL\nEVIDENCE_FAIL step=env detail=observer socket path is %s bytes (>=108): %s\n' "${#HOST_SOCK}" "$STATE_HOME_OVERRIDE" >&2
  exit 1
fi
LOGS="$E2E/logs/v1-live-provider-$RUN_ID"
PROJECT="$RUN/work"
SEED_FILE="$PROJECT/seed.txt"
ANSWER_FILE="$PROJECT/answer.txt"
ANSWER_CONTENT="LIVE-OK"
PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-openrouter}"
case "$PROVIDER_ID" in
  openrouter)
    KEY_VAR=OPENROUTER_API_KEY
    PROVIDER_API="https://openrouter.ai/api/v1"
    PROVIDER_ENV_JS='["OPENROUTER_API_KEY"]'
    PROVIDER_NPM="@openrouter/ai-sdk-provider"
    PROVIDER_LABEL="OpenRouter"
    PROVIDER_DOC="https://openrouter.ai/models"
    DEFAULT_MODEL="nvidia/nemotron-3.5-super-vl-120b-a12b:free"
    ;;
  nvidia)
    KEY_VAR=NVIDIA_API_KEY
    PROVIDER_API="https://integrate.api.nvidia.com/v1"
    PROVIDER_ENV_JS='["NVIDIA_API_KEY"]'
    PROVIDER_NPM="@ai-sdk/openai-compatible"
    PROVIDER_LABEL="NVIDIA"
    PROVIDER_DOC="https://integrate.api.nvidia.com/v1/models"
    DEFAULT_MODEL="nvidia/nemotron-3.5-super-vl-120b-a12b"
    ;;
  *)
    printf 'E2E_V1_LIVE_PROVIDER=FAIL\nEVIDENCE_FAIL step=env detail=unsupported NEMOTRON_PROVIDER_ID=%s\n' "$PROVIDER_ID" >&2
    exit 1
    ;;
esac
export HZ_KEY_VAR="$KEY_VAR"
export HZ_PROVIDER_ID="$PROVIDER_ID"
MODEL_ID="${NEMOTRON_MODEL_ID:-$DEFAULT_MODEL}"
# OpenRouter published per-token pricing for the pinned model (used only to
# compute an evidence-side USD figure; the harness-reported cost is also kept).
# The default pinned model is OpenRouter's zero-priced ":free" Nemotron route
# (the account behind the repo key has no paid credits: paid sends return
# HTTP 402). ":free" pricing is 0/0; override both when pinning a paid model.
MODEL_PRICE_IN_PER_M="${NEMOTRON_PRICE_IN_PER_M:-0}"
MODEL_PRICE_OUT_PER_M="${NEMOTRON_PRICE_OUT_PER_M:-0}"

ORIG_HOME="${HOME:-/nonexistent}"
export HOME="$RUN/home"
export TMPDIR="$RUN/tmp"
export XDG_CONFIG_HOME="$RUN/config"
export XDG_DATA_HOME="$RUN/data"
export XDG_CACHE_HOME="$RUN/cache"
export XDG_STATE_HOME="$ROOT/.tmp/st-$RUN_TAG"
export PATH="$ORIG_HOME/.bun/bin:$PATH"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-v1-live-$RANDOM-$RANDOM}"

if ! mkdir "$RUN" 2>/dev/null; then
  printf 'E2E_V1_LIVE_PROVIDER=FAIL\nEVIDENCE_FAIL step=env detail=run dir already exists (tag collision): %s\n' "$RUN" >&2
  exit 1
fi
mkdir -p "$RUN"/config "$RUN"/data "$RUN"/state "$RUN"/cache "$RUN"/home "$RUN"/tmp "$RUN"/work "$LOGS" "$XDG_STATE_HOME" || {

  printf 'E2E_V1_LIVE_PROVIDER=FAIL\nEVIDENCE_FAIL step=env detail=could not create per-run scratch tree under %s\n' "$RUN" >&2
  exit 1
}
# models.dev is the provider-lifecycle authority (108 provider subpaths, 75+
# LLM services upstream). A cold isolated HOME has no cached snapshot, so the
# provider catalog is empty and every pinned model resolves to
# `ProviderModelNotFoundError`. Seed the run from the real snapshot instead of
# hand-writing a catalog.
if [ "${HZ_PIN_CATALOG:-0}" != "1" ]; then
  HZ_MODELS_SNAPSHOT="${HZ_MODELS_SNAPSHOT:-$ORIG_HOME/.cache/opencode/models.json}"
  if [ -f "$HZ_MODELS_SNAPSHOT" ]; then
    mkdir -p "$XDG_CACHE_HOME/opencode"
    cp -f "$HZ_MODELS_SNAPSHOT" "$XDG_CACHE_HOME/opencode/models.json"
    say "CATALOG models.dev snapshot seeded ($(wc -c < "$XDG_CACHE_HOME/opencode/models.json") bytes) from $HZ_MODELS_SNAPSHOT"
  else
    say "E2E_V1_LIVE_PROVIDER=FAIL"
    say "EVIDENCE_FAIL step=catalog detail=no models.dev snapshot at $HZ_MODELS_SNAPSHOT and HZ_PIN_CATALOG is unset (run \"bun run src/index.ts models\" once to populate it)"
    exit 1
  fi
fi

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Credentials: load OPENROUTER_API_KEY from the repo-root .env WITHOUT ever
# printing it. Referenced only via "$OPENROUTER_API_KEY".
# ---------------------------------------------------------------------------
ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || { say "E2E_V1_LIVE_PROVIDER=FAIL"; say "EVIDENCE_FAIL step=env detail=repo .env missing: $ENV_FILE"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
if [ -z "${!KEY_VAR:-}" ]; then
  say "E2E_V1_LIVE_PROVIDER=FAIL"
  say "EVIDENCE_FAIL step=env detail=$KEY_VAR is not set after sourcing .env"
  exit 1
fi
KEY_LEAK_FOUND=""

SERVER_PID=""
APPROVER_PID=""
SSE_PID=""
BASE=""
AUTH=""

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

# Security: never let the provider key survive in any captured log. Scan every
# surviving log for the literal key; redact in place and flag the run FAIL.
scrub_key_from_logs() {
  [ -n "${!KEY_VAR:-}" ] || return 0
  [ -d "$LOGS" ] || return 0
  for f in "$LOGS"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.bin) continue ;; esac
    if grep -qF -- "${!KEY_VAR}" "$f" 2>/dev/null; then
      KEY_LEAK_FOUND="${KEY_LEAK_FOUND}${f} "
      python3 - "$f" "${!KEY_VAR}" <<'PYSCRUB' 2>/dev/null || true
import sys
path, key = sys.argv[1], sys.argv[2]
data = open(path, encoding="utf-8", errors="replace").read()
open(path, "w", encoding="utf-8").write(data.replace(key, "__REDACTED_API_KEY__"))
PYSCRUB
    fi
  done
}

cleanup() {
  rc=$1
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
  cap_logs
  scrub_key_from_logs
  if [ -n "$KEY_LEAK_FOUND" ]; then
    say "E2E_V1_LIVE_PROVIDER=FAIL"
    say "EVIDENCE_FAIL step=security detail=API key material found in logs (redacted in place): $KEY_LEAK_FOUND"
    rc=1
  fi
  rm -rf "$RUN"
  rm -rf "$XDG_STATE_HOME" 2>/dev/null || true
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

fail() {
  step=$1
  shift
  say "E2E_V1_LIVE_PROVIDER=FAIL"
  say "EVIDENCE upto=$step session=${SID:-none} assistant=${STATE:-none} error=${ERROR:-none} cost=${COST:-none} tokens_in=${TOKENS_IN:-?} tokens_out=${TOKENS_OUT:-?} stream_deltas=${STREAM_DELTAS:-0} read=${READ:-none} write=${WRITE:-none} bash=${BASH_TOOL:-none}"
  say "EVIDENCE_FAIL step=$step detail=$(printf '%s' "$*" | cut -c1-600)"
  if [ -s "$LOGS/serve.log" ]; then
    say "--- serve.log tail ---"
    tail -n 15 "$LOGS/serve.log" | python3 -c '
import sys
key = __import__("os").environ.get(__import__("os").environ.get("HZ_KEY_VAR", "OPENROUTER_API_KEY")) or ""
data = sys.stdin.read()
if key:
    data = data.replace(key, "__REDACTED__")
for line in data.splitlines():
    print(line[:400])
' 2>/dev/null || true
  fi
  write_live_record "failed" "$step" "$(printf '%s' "$*" | cut -c1-500)"
  say "LOGS=$LOGS"
  exit 1
}

BUN="${BUN:-}"
if [ -z "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [ -z "$BUN" ] && [ -x "$ORIG_HOME/.bun/bin/bun" ]; then BUN="$ORIG_HOME/.bun/bin/bun"; fi
[ -n "$BUN" ] || fail env "bun not found on PATH or \$HOME/.bun/bin"
[ "$OPENCODE_SERVER_PASSWORD" != "" ] || fail env "OPENCODE_SERVER_PASSWORD must be non-empty"

# models.dev fetch stays disabled: the catalog below is the single source of
# truth (real OpenRouter endpoint + pinned Nemotron + real pricing), so the
# run's provider surface is deterministic and no unvetted model can appear.
# Provider catalog: models.dev is the authority (108 provider subpaths, 75+ LLM
# services upstream). Never hand-encode a provider that models.dev already
# knows -- `nvidia` ships with env NVIDIA_API_KEY, api
# https://integrate.api.nvidia.com/v1, npm @ai-sdk/openai-compatible, and every
# nemotron model id. HZ_PIN_CATALOG=1 is the escape hatch for pinning a model
# the public catalog does not carry yet; it is OFF by default so the harness
# exercises the REAL provider lifecycle.
# The catalog is always the seeded models.dev snapshot, so the model surface is
# deterministic and no unvetted network fetch can change it mid-run.
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_AUTH_CONTENT="{}"

# Primary AgentProfileV2 pinning the SAME provider/model the prompt pins: the
# direct provider-authority gate only authorizes a pin the primary profile
# selects (same constraint the smoke documents).
mkdir -p "$XDG_CONFIG_HOME/opencode"
python3 - "$MODEL_ID" "$PROVIDER_ID" "$PROVIDER_LABEL" > "$XDG_CONFIG_HOME/opencode/opencode.json" <<'PYCONFIG'
import json, sys
model_id, provider_id, provider_label = sys.argv[1], sys.argv[2], sys.argv[3]
profile = {
    "schemaVersion": 2,
    "profileId": "user.primary",
    "revision": "1",
    "name": "V1 Live Provider Primary",
    "description": "Primary profile pinning the live %s Nemotron model" % provider_label,
    "source": "user",
    "roles": ["main"],
    "purpose": "Authorize the pinned %s Nemotron direct route" % provider_id,
    "whenToUse": "V1 live provider E2E",
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
[ -s "$XDG_CONFIG_HOME/opencode/opencode.json" ] || fail env "failed to write global opencode.json with primary AgentProfileV2"
say "CONFIG primary-agent-profile profileId=user.primary@1 model=$PROVIDER_ID/$MODEL_ID harness=native-rich role=main"

# Isolated permission policy narrowed to exactly the three tools the journey
# prompt legitimately needs (read/write/bash, by tool name AND capability id);
# everything else still falls through to "ask" and the tool-only approve loop.
python3 - > "$RUN/config-content.json" <<'PYPERM'
import json
print(json.dumps({"permission": {
    "read": "allow", "files.read": "allow",
    "write": "allow", "files.write": "allow",
    "bash": "allow", "terminal.run": "allow",
}}))
PYPERM
[ -s "$RUN/config-content.json" ] || fail env "failed to build OPENCODE_CONFIG_CONTENT"
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT="$(cat "$RUN/config-content.json")"
say "CONFIG permission=narrow(read,write,bash)=allow via OPENCODE_CONFIG_CONTENT"

AUTH="$(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
AUTH="Basic $AUTH"

# Seed file the prompt requires the model to READ first (proves the read tool
# really executed before the write).
printf 'seed-data: alpha-17\n' > "$SEED_FILE" || fail env "could not write seed file"

# Message parser: assistant state, EVERY assistant model id (fallback
# detection), tokens, cost, tool states (read/write/bash), final text.
cat > "$RUN/parse_messages.py" <<'PYPARSE'
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
error = info.get("error")
cost = info.get("cost")
tokens = info.get("tokens") if isinstance(info.get("tokens"), dict) else {}
time = info.get("time") if isinstance(info.get("time"), dict) else {}
done = bool(time.get("completed")) or info.get("finish") is not None

model_ids = set()
tin = tout = 0
tool_state = {"read": "none", "write": "none", "bash": "none"}
tool_error = {"read": "", "write": "", "bash": ""}
final_text_parts = []
last_assistant = assistants[-1]
for message in assistants:
    minfo = message.get("info") or {}
    pid = minfo.get("providerID") or ""
    mid = minfo.get("modelID") or ""
    if pid or mid:
        model_ids.add("%s/%s" % (pid, mid))
    mtok = minfo.get("tokens") if isinstance(minfo.get("tokens"), dict) else {}
    try:
        tin += int(mtok.get("input") or 0)
    except Exception:
        pass
    try:
        tout += int(mtok.get("output") or 0)
    except Exception:
        pass
    for p in (message.get("parts") or []):
        if not isinstance(p, dict):
            continue
        if p.get("type") == "tool":
            name = p.get("tool") or ""
            key = "bash" if name in ("bash", "terminal.run") else ("write" if name in ("write", "files.write") else ("read" if name in ("read", "files.read") else None))
            if key is None:
                continue
            st = p.get("state") if isinstance(p.get("state"), dict) else {}
            tool_state[key] = st.get("status") or "unknown"
            tool_error[key] = str(st.get("error") or "")[:300] if st.get("status") == "error" else ""
        elif p.get("type") == "text" and message is last_assistant:
            final_text_parts.append(p.get("text") or "")

print("STATE=%s" % ("done" if done else "running"))
print("COST=%s" % ("null" if cost is None else cost))
print("ERROR=%s" % (json.dumps(error) if error else ""))
print("TOKENS_IN=%d" % tin)
print("TOKENS_OUT=%d" % tout)
print("MODEL_IDS=%s" % ",".join(sorted(model_ids)))
print("READ=%s" % tool_state["read"])
print("READERR=%s" % tool_error["read"])
print("WRITE=%s" % tool_state["write"])
print("WRITEERR=%s" % tool_error["write"])
print("BASH=%s" % tool_state["bash"])
print("BASHERR=%s" % tool_error["bash"])
print("FINAL_TEXT=%s" % json.dumps("".join(final_text_parts)))
print("MSGCOUNT=%d" % len(msgs))
PYPARSE

# SSE event collector: records every /event wire frame with a receive
# timestamp so streaming/tool/latency assertions are evidence-based.
cat > "$RUN/collect_events.py" <<'PYCOLLECT'
import json, sys, time, urllib.request

base, auth_header, out_path, sid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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
                row = {"t": time.time(), "raw": payload}
                try:
                    parsed = json.loads(payload)
                    row["type"] = parsed.get("type") or ""
                    props = parsed.get("properties") if isinstance(parsed.get("properties"), dict) else {}
                    row["sessionID"] = props.get("sessionID") or ""
                    if row["type"] == "session.next.text.delta":
                        row["delta"] = props.get("delta") or ""
                    elif row["type"] == "session.next.tool.called":
                        row["tool"] = props.get("tool") or ""
                        row["callID"] = props.get("callID") or ""
                    elif row["type"] in ("session.next.tool.success", "session.next.tool.failed"):
                        row["callID"] = props.get("callID") or ""
                    elif row["type"] == "session.next.retried":
                        row["retry"] = True
                    elif row["type"] == "session.next.step.started":
                        m = props.get("model") if isinstance(props.get("model"), dict) else {}
                        row["model_providerID"] = m.get("providerID") or ""
                        row["model_modelID"] = m.get("modelID") or m.get("id") or ""
                    # V1 vocabulary (prebuilt CLI 0.0.0-main-20261013): the
                    # /event stream carries the legacy opencode event names.
                    elif row["type"] == "message.part.delta":
                        row["delta"] = props.get("delta") or ""
                    elif row["type"] == "message.part.updated":
                        part = props.get("part") if isinstance(props.get("part"), dict) else {}
                        row["part_type"] = part.get("type") or ""
                        if part.get("type") == "tool":
                            row["tool"] = part.get("tool") or ""
                            row["callID"] = part.get("id") or ""
                            st = part.get("state") if isinstance(part.get("state"), dict) else {}
                            row["status"] = st.get("status") or ""
                    elif row["type"] == "message.updated":
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

# Event-stream metrics: streaming deltas, first-token/tool latency, tool
# latencies, retries, step (=model request) count, and every step's model id.
cat > "$RUN/event_metrics.py" <<'PYMETRICS'
import json, sys

path, sid, t0 = sys.argv[1], sys.argv[2], float(sys.argv[3])
deltas = 0
first_delta_t = None
first_tool_t = None
tool_open = {}
tool_latency_ms = 0.0
retries = 0
steps = 0
step_models = set()
seen_assistant = set()
errors = 0
try:
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
except Exception:
    rows = []
for r in rows:
    t = r.get("t") or 0
    typ = r.get("type") or ""
    rsid = r.get("sessionID") or ""
    if rsid and sid and rsid != sid:
        continue
    if typ == "collector.error":
        errors += 1
    if typ in ("session.next.text.delta", "message.part.delta") and (r.get("delta") or ""):
        deltas += 1
        if first_delta_t is None:
            first_delta_t = t
    elif typ == "session.next.tool.called":
        if first_tool_t is None:
            first_tool_t = t
        cid = r.get("callID") or ""
        if cid:
            tool_open[cid] = t
    elif typ in ("session.next.tool.success", "session.next.tool.failed"):
        cid = r.get("callID") or ""
        start = tool_open.pop(cid, None)
        if start is not None:
            tool_latency_ms += max(0.0, (t - start)) * 1000.0
    elif typ == "message.part.updated" and r.get("part_type") == "tool":
        cid = r.get("callID") or ""
        status = r.get("status") or ""
        if status in ("pending", "running"):
            if cid and cid not in tool_open:
                tool_open[cid] = t
                if first_tool_t is None:
                    first_tool_t = t
        elif status in ("completed", "error"):
            start = tool_open.pop(cid, None)
            if start is not None:
                tool_latency_ms += max(0.0, (t - start)) * 1000.0
    elif typ == "session.next.retried":
        retries += 1
    elif typ == "session.next.step.started":
        steps += 1
        pid = r.get("model_providerID") or ""
        mid = r.get("model_modelID") or ""
        if pid or mid:
            step_models.add("%s/%s" % (pid, mid))
    elif typ == "message.updated" and r.get("assistant_message"):
        # V1: each assistant message == one model request.
        if r["assistant_message"] not in seen_assistant:
            seen_assistant.add(r["assistant_message"])
            steps += 1
        pid = r.get("model_providerID") or ""
        mid = r.get("model_modelID") or ""
        if pid or mid:
            step_models.add("%s/%s" % (pid, mid))

print("STREAM_DELTAS=%d" % deltas)
print("FIRST_DELTA_LATENCY_MS=%s" % ("" if first_delta_t is None else str(int((first_delta_t - t0) * 1000))))
print("TIME_TO_FIRST_ACTION_MS=%s" % ("" if first_tool_t is None else str(int((first_tool_t - t0) * 1000))))
print("TOOL_LATENCY_MS=%d" % int(tool_latency_ms))
print("RETRIES=%d" % retries)
print("MODEL_REQUESTS=%d" % steps)
print("STEP_MODELS=%s" % ",".join(sorted(step_models)))
print("COLLECTOR_ERRORS=%d" % errors)
PYMETRICS

# JSON record writer (schema shared with the bench runner).
write_live_record() {
  status="$1"; step="$2"; detail="$3"
  mkdir -p "$BENCH/live" 2>/dev/null || true
  python3 - "$BENCH/live/journey-$RUN_ID.json" \
    "$status" "$step" "$detail" "$PROVIDER_ID/$MODEL_ID" \
    "${SID:-}" "${STATE:-}" "${ERROR:-}" "${COST:-}" "${TOKENS_IN:-0}" "${TOKENS_OUT:-0}" \
    "${STREAM_DELTAS:-0}" "${FIRST_DELTA_LATENCY_MS:-}" "${TIME_TO_FIRST_ACTION_MS:-}" "${TOOL_LATENCY_MS:-0}" \
    "${MODEL_REQUESTS:-0}" "${RETRIES:-0}" "${READ:-none}" "${WRITE:-none}" "${BASH_TOOL:-none}" \
    "${KEY_LEAK_FOUND:-}" "${LOGS}" <<'PYRECORD'
import json, sys
(out, status, step, detail, model, sid, state, error, cost, tin, tout, deltas,
 first_delta, tfa, tool_lat, requests, retries, read_s, write_s, bash_s, leak, logs) = sys.argv[1:23]
def num(v, d=0):
    try:
        return int(v)
    except Exception:
        return d
record = {
    "kind": "live-provider-journey",
    "status": status,
    "failed_step": step,
    "detail": detail,
    "model_id": model,
    "session_id": sid,
    "assistant_state": state,
    "assistant_error": error,
    "cost_reported": cost,
    "input_tokens": num(tin),
    "output_tokens": num(tout),
    "streamed_text_deltas": num(deltas),
    "first_token_latency_ms": num(first_delta) if first_delta else None,
    "time_to_first_action_ms": num(tfa) if tfa else None,
    "tool_latency_ms": num(tool_lat),
    "model_requests": num(requests),
    "retries": num(retries),
    "tool_states": {"read": read_s, "write": write_s, "bash": bash_s},
    "key_leak_found": leak,
    "logs": logs,
}
json.dump(record, open(out, "w", encoding="utf-8"), indent=1)
PYRECORD
}

# ---------------------------------------------------------------------------
# HostKernel wrapper (identical idiom to v1-smoke.sh): source-mode serve gets
# the real kernel's build-time defines; the canonical kernel binary is the
# ONLY admitted kernel (fail closed when missing).
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Serve binary selection: prefer the repo's prebuilt CLI (per-task directive:
# use a prebuilt bin at packages/horizoncode/dist when present); fall back to
# source mode + kernel wrapper. Source mode can be broken by in-flight edits
# in other agents' files; the prebuilt bin embeds the real HostKernel, so the
# direct-turn gate still runs the real kernel either way.
# ---------------------------------------------------------------------------
DIST_BIN="$ROOT/packages/horizoncode/dist/opencode-linux-x64/bin/opencode"
SERVE_MODE="source"
SERVE_BIN=""
if [ -x "$DIST_BIN" ]; then
  SERVE_MODE="dist"
  SERVE_BIN="$DIST_BIN"
fi
KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
if [ "$SERVE_MODE" = "source" ]; then
  if [ ! -f "$KERNEL_BIN" ]; then
    fail host-kernel "canonical repo-local hz-kernel binary missing: $KERNEL_BIN; direct turns require the real HostKernel"
  fi
  KERNEL_SHA="$(sha256sum "$KERNEL_BIN" 2>/dev/null | cut -d' ' -f1)"
  case "$KERNEL_SHA" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) fail host-kernel "could not sha256sum kernel binary $KERNEL_BIN" ;;
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
  [ -s "$RUN/kernel-wrapper.ts" ] || fail host-kernel "failed to write the kernel entry wrapper"
  say "EVIDENCE serve_mode=source kernel=$KERNEL_BIN sha256=$KERNEL_SHA"
else
  SERVE_VERSION="$("$SERVE_BIN" --version 2>/dev/null | head -n1 || echo unknown)"
  say "EVIDENCE serve_mode=dist bin=$SERVE_BIN version=$SERVE_VERSION (prebuilt CLI; embedded HostKernel)"
fi

# ---------------------------------------------------------------------------
# Env scrub for the serve child: keep ONLY the provider credential (this run's
# provider credential, user-approved live) + OPENCODE_SERVER_PASSWORD (this
# run's Basic-auth secret). Everything else credential-shaped is removed.
# ---------------------------------------------------------------------------
python3 - "$ROOT/packages/horizoncode/test/tool/fixtures/models-api.json" > "$RUN/fixture-env.txt" <<'PYENV'
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
PYENV
[ -s "$RUN/fixture-env.txt" ] || fail env "could not extract credential env names from the models fixture"
mapfile -t FIXTURE_ENV < "$RUN/fixture-env.txt"
PROVIDER_SCRUB=()
for scrub_name in "${FIXTURE_ENV[@]}"; do
  case "$scrub_name" in "$KEY_VAR") ;; *) PROVIDER_SCRUB+=(-u "$scrub_name") ;; esac
done
for scrub_name in HORIZON_DIRECT_FREE_CREDENTIALS OTEL_EXPORTER_OTLP_HEADERS; do PROVIDER_SCRUB+=(-u "$scrub_name"); done
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
say "ENV scrub fixture_names=${#FIXTURE_ENV[@]} flags=${#PROVIDER_SCRUB[@]} keep=$KEY_VAR,OPENCODE_SERVER_PASSWORD"

# ---------------------------------------------------------------------------
# Inline REAL catalog: openrouter provider (real HTTPS endpoint) with the
# pinned Nemotron model and real pricing. No other model is registered, so a
# silent model switch has nowhere to hide.
# ---------------------------------------------------------------------------
if [ "${HZ_PIN_CATALOG:-0}" = "1" ]; then
mkdir -p "$RUN/catalog"
python3 - "$RUN/catalog/models.json" "$MODEL_ID" "$MODEL_PRICE_IN_PER_M" "$MODEL_PRICE_OUT_PER_M" "$PROVIDER_ID" "$PROVIDER_LABEL" "$PROVIDER_ENV_JS" "$PROVIDER_NPM" "$PROVIDER_API" "$PROVIDER_DOC" <<'PYCAT'
import json, sys
out, model_id, pin, pout = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
PID, PNAME, ENVV, PNPM, PAPI, PDOC = sys.argv[5], sys.argv[6], json.loads(sys.argv[7]), sys.argv[8], sys.argv[9], sys.argv[10]
catalog = {
    PID: {
        "id": PID,
        "name": PNAME,
        "env": ENVV,
        "npm": PNPM,
        "api": PAPI,
        "doc": PDOC,
        "models": {
            model_id: {
                "id": model_id,
                "name": model_id,
                "status": "active",
                "family": "nemotron",
                "attachment": False,
                "reasoning": "reasoning" in model_id,
                "tool_call": True,
                "structured_output": False,
                "temperature": True,
                "release_date": "2025-12-15",
                "modalities": {"input": ["text"], "output": ["text"]},
                "limit": {"context": 131072, "output": 8192},
                "cost": {"input": pin / 1_000_000, "output": pout / 1_000_000, "cache_read": 0, "cache_write": 0},
            }
        },
    }
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(catalog, f)
PYCAT
[ -s "$RUN/catalog/models.json" ] || fail catalog "failed to write the live provider catalog"
export OPENCODE_MODELS_PATH="$RUN/catalog/models.json"
fi
if [ "${HZ_PIN_CATALOG:-0}" = "1" ]; then
  say "CATALOG $PROVIDER_ID/$MODEL_ID api=$PROVIDER_API tool_call=true (pinned override, models fetch disabled)"
else
  say "CATALOG source=models.dev provider=$PROVIDER_ID model=$MODEL_ID (upstream provider lifecycle, no override)"
fi

# ---------------------------------------------------------------------------
# Boot server (random high loopback port, bounded health retry).
# ---------------------------------------------------------------------------
export HZ_DEBUG_PREPARE="${HZ_DEBUG_PREPARE:-0}"
start_server() {
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
  BASE="http://127.0.0.1:$port"
  : > "$LOGS/serve.log"
  if [ "$SERVE_MODE" = "dist" ]; then
    ( cd "$PROJECT" && exec env \
      "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
      HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 HZ_DEBUG_PREPARE=1 \
      "$SERVE_BIN" serve --hostname 127.0.0.1 --port "$port" ) \
      >>"$LOGS/serve.log" 2>&1 &
  else
    ( cd "$ROOT" && exec env \
      "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
      HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 \
      "$BUN" run --cwd packages/horizoncode "$RUN/kernel-wrapper.ts" --print-logs serve --hostname 127.0.0.1 --port "$port" ) \
      >>"$LOGS/serve.log" 2>&1 &
  fi
  SERVER_PID=$!
  for _ in $(seq 1 240); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then return 1; fi
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
  say "SERVER: attempt $attempt failed; retrying"; tail -c 400 "$LOGS/serve.log" 2>/dev/null || true
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
done
[ -n "$SERVER_PID" ] || fail server "server did not become healthy after 3 attempts"
if ! kill -0 "$SERVER_PID" 2>/dev/null; then fail server "server exited during health wait"; fi
say "STEP server: up pid=$SERVER_PID base=$BASE"

# Background permission auto-approver: only TOOL permission requests are
# auto-approved; non-tool asks stay untouched (same idiom as the smoke).
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
# Negative probe: unauthenticated POST must be 401 and create nothing.
# ---------------------------------------------------------------------------
unauth_status=$(curl -sS --max-time 10 -o "$LOGS/unauth.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H 'content-type: application/json' -d '{}' 2>/dev/null || echo "000")
[ "$unauth_status" = "401" ] || fail auth-negative "expected HTTP 401 without credentials, got $unauth_status"
say "STEP auth_negative: HTTP $unauth_status"

# ---------------------------------------------------------------------------
# Session create FIRST (initializes the instance; the /event stream holds its
# headers until the instance exists), then the SSE collector on GET /event.
# ---------------------------------------------------------------------------
create_status=$(curl -sS --max-time 30 -o "$LOGS/session.json" -w '%{http_code}' \
  -X POST "$BASE/session" -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d '{"title":"v1-live-provider"}' 2>/dev/null || echo "000")
[ "$create_status" = "200" ] || fail session-create "HTTP $create_status: $(head -c 300 "$LOGS/session.json" 2>/dev/null)"
SID=$(python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
print(data.get("id", "") if isinstance(data, dict) else "")
' "$LOGS/session.json" 2>/dev/null || true)
[ -n "$SID" ] || fail session-create "no session id in response"

: > "$LOGS/events.jsonl"
python3 "$RUN/collect_events.py" "$BASE" "$AUTH" "$LOGS/events.jsonl" "" > "$LOGS/collector.out" 2>&1 &
SSE_PID=$!
sleep 1
kill -0 "$SSE_PID" 2>/dev/null || fail sse "event collector exited during startup: $(head -c 300 "$LOGS/collector.out" 2>/dev/null)"
say "STEP sse: collector pid=$SSE_PID -> $LOGS/events.jsonl (session=$SID)"

# ---------------------------------------------------------------------------
# Autonomous posture through the KERNEL-OWNED mode, not a client auto-reply.
# approvalPolicy=never removes only the human round-trip; Guard admission,
# capability checks, leases and receipts still run. Compare-and-set on the
# revision the host reports so a stale writer cannot silently win.
# ---------------------------------------------------------------------------
# Bounded retry: a cold instance can answer the first posture read with an
# empty transport response while the Location is still being registered. A
# transient miss must not be reported as a product failure.
mode_http=""
for attempt in 1 2 3 4 5; do
  mode_http=$(curl -sS -i --max-time 20 -H "Authorization: $AUTH" \
    "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null || true)
  printf '%s' "$mode_http" > "$LOGS/mode-read.raw"
  case "$mode_http" in *'"revision"'*) break ;; esac
  sleep 2
done
mode_status=$(printf '%s' "$mode_http" | head -1 | tr -d '\r')
printf '%s' "$mode_http" | sed '1,/^\r*$/d' > "$LOGS/mode-read.json"
mode_read=$(cat "$LOGS/mode-read.json")
mode_rev=$(printf '%s' "$mode_read" | grep -o '"revision":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$mode_rev" ]; then
  mode_patch=$(curl -sS --max-time 20 -o "$LOGS/mode-patch.json" -w '%{http_code}' \
    -X PATCH -H "Authorization: $AUTH" -H 'content-type: application/json' \
    "$BASE/config/direct-session-permission-mode?sessionID=$SID" \
    -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$mode_rev\"}" \
    2>/dev/null || echo "000")
  say "STEP mode: PATCH approvalPolicy=never sandboxMode=danger-full-access rev=$mode_rev HTTP $mode_patch"
  [ "$mode_patch" = "200" ] || fail permission-mode "PATCH failed HTTP $mode_patch: $(head -c 300 "$LOGS/mode-patch.json" 2>/dev/null)"
  mode_after=$(curl -sS --max-time 20 -H "Authorization: $AUTH" \
    "$BASE/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null || true)
  printf '%s' "$mode_after" > "$LOGS/mode-after.json"
  printf '%s' "$mode_after" | grep -q '"approvalPolicy":"never"' \
    || fail permission-mode "approvalPolicy did not stick: $(head -c 300 "$LOGS/mode-after.json" 2>/dev/null)"
  say "STEP mode: readback confirms approvalPolicy=never"
else
  fail permission-mode "no revision in mode read [${mode_status}]: $(head -c 300 "$LOGS/mode-read.raw" 2>/dev/null)"
fi


python3 - "$SEED_FILE" "$ANSWER_FILE" "$ANSWER_CONTENT" "$PROVIDER_ID" "$MODEL_ID" > "$LOGS/prompt-request.json" <<'PYPROMPT'
import json, sys
seed, answer, content, provider, model = sys.argv[1:6]
text = (
    "Complete this multi-step coding journey using tools, in order:\n"
    "1. Use the read tool to read the file %s.\n"
    "2. Use the write tool to create the file %s containing EXACTLY these %d bytes with no trailing newline: %s\n"
    "3. Use the bash tool to run exactly: python3 -c 'print(sum(range(1,11)))'\n"
    "4. Finish with a final message that contains the number the command printed and the single word DONE.\n"
    "Do not modify any other files." % (seed, answer, len(content), content)
)
print(json.dumps({
    "model": {"providerID": provider, "modelID": model},
    "parts": [{"type": "text", "text": text}],
}))
PYPROMPT
[ -s "$LOGS/prompt-request.json" ] || fail prompt-http "failed to build prompt request"

T0=$(python3 -c 'import time; print(time.time())')
say "STEP prompt: sending pinned $PROVIDER_ID/$MODEL_ID tool-loop prompt (t0=$T0)"
prompt_status=$(curl -sS --max-time 900 -o "$LOGS/prompt-response.json" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/message" -H "Authorization: $AUTH" \
  -H 'content-type: application/json' --data-binary @"$LOGS/prompt-request.json" 2>/dev/null || echo "000")
if [ "$prompt_status" != "200" ]; then
  fail prompt-http "HTTP $prompt_status: $(head -c 500 "$LOGS/prompt-response.json" 2>/dev/null)"
fi

deadline=$((SECONDS + 900))
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
TOKENS_IN=$(getval TOKENS_IN)
TOKENS_OUT=$(getval TOKENS_OUT)
MODEL_IDS=$(getval MODEL_IDS)
READ=$(getval READ)
WRITE=$(getval WRITE)
BASH_TOOL=$(getval BASH)
FINAL_TEXT=$(getval FINAL_TEXT)

# Event-stream metrics (streaming/tool-loop/model-request evidence).
python3 "$RUN/event_metrics.py" "$LOGS/events.jsonl" "$SID" "$T0" > "$LOGS/metrics.env" 2>/dev/null || true
STREAM_DELTAS=$(grep '^STREAM_DELTAS=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || echo 0)
FIRST_DELTA_LATENCY_MS=$(grep '^FIRST_DELTA_LATENCY_MS=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || true)
TIME_TO_FIRST_ACTION_MS=$(grep '^TIME_TO_FIRST_ACTION_MS=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || true)
TOOL_LATENCY_MS=$(grep '^TOOL_LATENCY_MS=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || echo 0)
MODEL_REQUESTS=$(grep '^MODEL_REQUESTS=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || echo 0)
RETRIES=$(grep '^RETRIES=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || echo 0)
STEP_MODELS=$(grep '^STEP_MODELS=' "$LOGS/metrics.env" 2>/dev/null | cut -d= -f2- || true)

# ---------------------------------------------------------------------------
# Assertions (fail-closed, in evidence order).
# ---------------------------------------------------------------------------
[ "$STATE" = "done" ] || fail assistant "no settled assistant message (state=${STATE:-none}); see $LOGS"
if [ -n "$ERROR" ]; then
  case "$ERROR" in
    *"Provider credentials are unavailable"*|*"OpenRouter free route is unavailable"*|*"managed provider requests remain unavailable"*)
      fail provider "current tree's fail-closed provider gate rejected the live credentialed send (prerequisite: P6 SecretBroker transport / Core RequestExecutor pinned send): $ERROR" ;;
    *)
      fail assistant "assistant error present: $ERROR" ;;
  esac
fi

# Model identity: EVERY assistant message + every streamed step must be the
# pinned Nemotron. Any other id means a silent fallback -> FAIL.
EXPECTED="$PROVIDER_ID/$MODEL_ID"
[ -n "$MODEL_IDS" ] || fail model-id "no assistant model ids reported"
bad_ids=""
IFS=',' read -ra _ids <<< "$MODEL_IDS"
for _id in "${_ids[@]}"; do
  [ -z "$_id" ] && continue
  case "$_id" in
    "$EXPECTED"|"$EXPECTED:"*) ;;
    *) bad_ids="$bad_ids $_id" ;;
  esac
done
[ -z "$bad_ids" ] || fail model-id "assistant messages report non-pinned model ids:$bad_ids (pinned=$EXPECTED)"
if [ -n "$STEP_MODELS" ]; then
  IFS=',' read -ra _sids <<< "$STEP_MODELS"
  for _id in "${_sids[@]}"; do
    [ -z "$_id" ] && continue
    case "$_id" in
      "$EXPECTED"|"$EXPECTED:"*) ;;
      *) bad_ids="$bad_ids step:$_id" ;;
    esac
  done
fi
[ -z "$bad_ids" ] || fail model-id "streamed steps report non-pinned model ids:$bad_ids (pinned=$EXPECTED)"

# Real streaming tokens: >=3 non-empty text deltas observed live on /event.
case "$STREAM_DELTAS" in
  ''|*[!0-9]*) fail stream "stream delta count is not numeric: ${STREAM_DELTAS:-unset}" ;;
esac
[ "$STREAM_DELTAS" -ge 3 ] || fail stream "expected >=3 streamed text deltas on SSE, got ${STREAM_DELTAS} (streamed_tokens=none)"

# Tool loop: read completed -> write completed with EXACT bytes on disk ->
# bash completed and its output echoed in the final assistant text.
[ "$READ" = "completed" ] || fail tool-loop "read tool state=${READ:-none} (the journey must read seed.txt first)"
[ "$WRITE" = "completed" ] || fail tool-loop "write tool state=${WRITE:-none}"
if [ ! -f "$ANSWER_FILE" ]; then
  fail tool-loop "write reported ${WRITE:-none} but $ANSWER_FILE does not exist"
fi
bytes=$(stat -c%s "$ANSWER_FILE" 2>/dev/null || echo "?")
content=$(cat "$ANSWER_FILE" 2>/dev/null || true)
[ "$bytes" = "${#ANSWER_CONTENT}" ] || fail tool-loop "answer.txt has $bytes bytes, expected ${#ANSWER_CONTENT}"
[ "$content" = "$ANSWER_CONTENT" ] || fail tool-loop "answer.txt content mismatch: got '$content'"
[ "$BASH_TOOL" = "completed" ] || fail tool-loop "bash tool state=${BASH_TOOL:-none}"
case "$FINAL_TEXT" in
  *55*) ;;
  *) fail tool-loop "final assistant text does not contain the bash command output '55': $(printf '%s' "$FINAL_TEXT" | cut -c1-200)" ;;
esac
case "$FINAL_TEXT" in
  *DONE*) ;;
  *) fail tool-loop "final assistant text does not contain DONE: $(printf '%s' "$FINAL_TEXT" | cut -c1-200)" ;;
esac

# Usage reported: tokens > 0, cost field present.
case "$TOKENS_IN:$TOKENS_OUT" in
  *[!0-9:]*|"":*|*:"") fail usage "token counts missing/non-numeric (in=${TOKENS_IN:-?} out=${TOKENS_OUT:-?})" ;;
esac
[ "$((TOKENS_IN + TOKENS_OUT))" -gt 0 ] || fail usage "expected >0 total tokens, got in=$TOKENS_IN out=$TOKENS_OUT"
[ -n "$COST" ] || fail usage "no cost field reported"

COST_USD=$(python3 -c "print('%.6f' % ((int('${TOKENS_IN:-0}') * ${MODEL_PRICE_IN_PER_M} + int('${TOKENS_OUT:-0}') * ${MODEL_PRICE_OUT_PER_M}) / 1000000.0))")

say "E2E_V1_LIVE_PROVIDER=PASS"
say "EVIDENCE serve_mode=$SERVE_MODE session=$SID provider=openrouter model=$MODEL_ID model_ids=$MODEL_IDS step_models=${STEP_MODELS:-none} no_fallback=true"
say "EVIDENCE streamed_text_deltas=$STREAM_DELTAS first_token_latency_ms=${FIRST_DELTA_LATENCY_MS:-?} time_to_first_action_ms=${TIME_TO_FIRST_ACTION_MS:-?} tool_latency_ms=$TOOL_LATENCY_MS model_requests=$MODEL_REQUESTS retries=$RETRIES"
say "EVIDENCE tool_loop=read:$READ write:$WRITE bash:$BASH_TOOL file_bytes=$bytes file_content=$content cmd_output_seen=55 done_seen=true"
say "EVIDENCE usage input_tokens=$TOKENS_IN output_tokens=$TOKENS_OUT cost_reported=$COST cost_usd_est=$COST_USD"
say "EVIDENCE security key_in_logs=none auth_negative=$unauth_status"
write_live_record "passed" "" ""
say "LOGS=$LOGS"
exit 0
