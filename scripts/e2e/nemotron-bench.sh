#!/usr/bin/env bash
# HorizonCode Nemotron SWE-bench-lite benchmark runner (Lead 4).
#
# Runs the 10 user-selected SWE-bench Verified tasks against HorizonCode with
# the PINNED Nemotron model (OpenRouter, default nvidia/nemotron-3-nano-30b-a3b
# — cheapest tools-capable Nemotron; verified per-request, no silent fallback)
# and records a per-task JSON run record plus a summary results sheet.
#
# Per task:
#   1. clone the pinned repo at the SWE-bench base commit (depth-1 fetch by SHA)
#      into an isolated scratch dir under .tmp/nemotron-bench/work/;
#   2. build a cheap venv (uv; Python version matched to the Django/library
#      version; only pure-python deps: sqlparse/pytz/asgiref). Heavy compiled
#      environments (matplotlib/xarray) are time-boxed and marked ENV_BLOCKED
#      instead of thrashing;
#   3. BASELINE probe: one PASS_TO_PASS test must pass at base (env sanity);
#   4. GOLD calibration: the dataset's gold patch + test_patch are run through
#      the exact same verification pipeline, proving the verification side
#      green independent of the model (recorded, clearly marked);
#   5. boot real `horizoncode serve` (source mode + canonical HostKernel
#      wrapper) with cwd = the task repo, on a random high loopback port with
#      HTTP basic auth; subscribe to /event SSE;
#   6. send the task prompt pinned to the Nemotron model; wait bounded
#      (NEMOTRON_BENCH_TIMEOUT_S, default 600s; abort on timeout);
#   7. capture the model patch (git diff including untracked), check for test
#      tampering, apply the SWE-bench test_patch, run FAIL_TO_PASS +
#      PASS_TO_PASS via the repo's own test runner, and classify:
#        verified_success = all FAIL_TO_PASS pass AND no PASS_TO_PASS
#        regressed AND no test tampering;
#   8. emit .tmp/nemotron-bench/runs/<task>.json (schema in the header of
#      emit_record) + raw patch + SSE tool-call trace + messages + test log.
#
# Failure taxonomy (failure_category): model | harness | environment |
# verification | infrastructure | budget | unknown. A failed task with a
# correct category is a valid result — this runner never fakes success. If the
# current tree's fail-closed provider gates reject the credentialed send
# (SecretBroker / Core RequestExecutor pending), every model attempt is
# recorded status=blocked, failure_category=harness with the exact error, while
# baseline + gold calibration still prove the env/verification pipeline.
#
# Task data: scripts/e2e/nemotron-bench/tasks.json (generated from the public
# SWE-bench Verified dataset: instance_id, repo, base_commit, version,
# FAIL_TO_PASS, PASS_TO_PASS, test_patch, gold patch, prompt).
#
# Isolation: one serve per task, random high port, unique scratch dirs, short
# per-run XDG_STATE_HOME (HostKernel socket < 108 bytes), no cargo, no shared
# state with other agents' e2e.
#
# Usage:
#   bash scripts/e2e/nemotron-bench.sh                        # default cheap subset
#   NEMOTRON_BENCH_TASKS=all bash scripts/e2e/nemotron-bench.sh
#   NEMOTRON_BENCH_TASKS=django__django-11099,django__django-13410 bash ...
#   NEMOTRON_BENCH_TIMEOUT_S=900 NEMOTRON_MODEL_ID=... bash ...
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Terminal containment needs a delegated, user-owned cgroup-v2 subtree.
# shellcheck source=lib/cgroup-scope.sh
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"
BENCH="$ROOT/.tmp/nemotron-bench"
TASKS_FILE="$ROOT/scripts/e2e/nemotron-bench/tasks.json"
RUNS="$BENCH/runs"
LOGS_ROOT="$BENCH/logs"
WORK_ROOT="$BENCH/work"
mkdir -p "$RUNS" "$LOGS_ROOT" "$WORK_ROOT" || { echo "BENCH=FAIL detail=cannot create $BENCH" >&2; exit 1; }

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
  *) say "BENCH=FAIL detail=unsupported NEMOTRON_PROVIDER_ID=$PROVIDER_ID"; exit 1 ;;
esac
export HZ_KEY_VAR="$KEY_VAR"
MODEL_ID="${NEMOTRON_MODEL_ID:-$DEFAULT_MODEL}"
# Default pinned model is OpenRouter's zero-priced ":free" Nemotron route (the
# account behind the repo key has no paid credits; paid sends return 402).
MODEL_PRICE_IN_PER_M="${NEMOTRON_PRICE_IN_PER_M:-0}"
MODEL_PRICE_OUT_PER_M="${NEMOTRON_PRICE_OUT_PER_M:-0}"
TASK_TIMEOUT_S="${NEMOTRON_BENCH_TIMEOUT_S:-600}"
ENV_INSTALL_CAP_S="${NEMOTRON_BENCH_ENV_CAP_S:-180}"
# Cheap-first default: the three user-priority pure-Python Django tasks, then
# the remaining pure-Python Django tasks. Heavy compiled-dep repos
# (matplotlib/xarray) run only when explicitly selected (env probe is
# time-boxed and marks them ENV_BLOCKED when the env cannot install quickly).
DEFAULT_TASKS="django__django-11099,django__django-13410,django__django-9296, django__django-11820,django__django-13820,django__django-16899,django__django-15503,django__django-11211"
DEFAULT_TASKS="$(printf '%s' "$DEFAULT_TASKS" | tr -d ' ')"
SELECT="${NEMOTRON_BENCH_TASKS:-$DEFAULT_TASKS}"

ORIG_HOME="${HOME:-/nonexistent}"
export PATH="$ORIG_HOME/.bun/bin:$HOME/.local/bin:$PATH"

say() { printf '%s\n' "$*"; }
[ -f "$TASKS_FILE" ] || { say "BENCH=FAIL detail=tasks file missing: $TASKS_FILE"; exit 1; }
[ -f "$ROOT/.env" ] || { say "BENCH=FAIL detail=repo .env missing (OPENROUTER_API_KEY)"; exit 1; }

# Load the provider credential without ever printing it (referenced only as
# "$OPENROUTER_API_KEY").
set -a
# shellcheck disable=SC1090
. "$ROOT/.env"
set +a
if [ -z "${!KEY_VAR:-}" ]; then
  say "BENCH=FAIL detail=$KEY_VAR not set after sourcing .env"
  exit 1
fi

BUN="${BUN:-}"
if [ -z "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [ -z "$BUN" ] && [ -x "$ORIG_HOME/.bun/bin/bun" ]; then BUN="$ORIG_HOME/.bun/bin/bun"; fi
[ -n "$BUN" ] || { say "BENCH=FAIL detail=bun not found"; exit 1; }

KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
DIST_BIN="$ROOT/packages/horizoncode/dist/opencode-linux-x64/bin/opencode"
if [ ! -f "$KERNEL_BIN" ] && [ ! -x "$DIST_BIN" ]; then
  say "BENCH=FAIL detail=neither prebuilt CLI ($DIST_BIN) nor canonical hz-kernel ($KERNEL_BIN) available"
  exit 1
fi
KERNEL_SHA=""
[ -f "$KERNEL_BIN" ] && KERNEL_SHA="$(sha256sum "$KERNEL_BIN" | cut -d' ' -f1)"

UV="$(command -v uv 2>/dev/null || true)"
if [ -z "$UV" ] && [ -x "$ORIG_HOME/.local/bin/uv" ]; then UV="$ORIG_HOME/.local/bin/uv"; fi

export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_AUTH_CONTENT="{}"

RESULTS_SHEET="$BENCH/results-sheet.md"
: > "$BENCH/bench-summary.log"

# Credential env scrub list for the serve child: keep OPENROUTER_API_KEY +
# OPENCODE_SERVER_PASSWORD only (same policy as v1-live-provider.sh).
python3 - "$ROOT/packages/horizoncode/test/tool/fixtures/models-api.json" > "$BENCH/fixture-env.txt" 2>/dev/null <<'PYENV'
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
PROVIDER_SCRUB=()
if [ -s "$BENCH/fixture-env.txt" ]; then
  mapfile -t FIXTURE_ENV < "$BENCH/fixture-env.txt"
  for scrub_name in "${FIXTURE_ENV[@]}"; do
    case "$scrub_name" in "$KEY_VAR") ;; *) PROVIDER_SCRUB+=(-u "$scrub_name") ;; esac
  done
fi
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

# ---------------------------------------------------------------------------
# emit_record: write one per-task JSON run record (the user's schema).
# ---------------------------------------------------------------------------
emit_record() {
  python3 - "$RUNS/$TASK.json" <<'PYRECORD' "$@"
import json, sys, os
out = sys.argv[1]
keys = [
    "task_id", "model_id", "base_commit", "status", "verified_success",
    "fail_to_pass_passed", "fail_to_pass_total", "pass_to_pass_failed",
    "duration_ms", "time_to_first_action_ms", "model_latency_ms", "tool_latency_ms",
    "input_tokens", "output_tokens", "model_requests", "tool_calls", "tool_errors",
    "retries", "files_changed", "lines_added", "lines_removed", "crashed",
    "timed_out", "failure_category",
    "error", "python_version", "repo", "patch_path", "events_path",
    "messages_path", "tests_log", "calibration", "test_tampering", "patch_produced",
]
record = {}
args = sys.argv[2:]
i = 0
while i < len(args) - 1:
    record[args[i]] = args[i + 1]
    i += 2
for k in ("verified_success", "crashed", "timed_out", "test_tampering", "patch_produced"):
    if k in record:
        record[k] = record[k] == "true"
for k in ("fail_to_pass_passed", "fail_to_pass_total", "pass_to_pass_failed", "duration_ms",
          "time_to_first_action_ms", "model_latency_ms", "tool_latency_ms", "input_tokens",
          "output_tokens", "model_requests", "tool_calls", "tool_errors", "retries",
          "files_changed", "lines_added", "lines_removed"):
    if k in record and record[k] not in ("", None):
        try:
            record[k] = int(record[k])
        except Exception:
            pass
    elif k in record and record[k] == "":
        record[k] = None
ordered = {k: record.get(k) for k in keys if k in record}
for k, v in record.items():
    if k not in ordered:
        ordered[k] = v
json.dump(ordered, open(out, "w", encoding="utf-8"), indent=1)
PYRECORD
}

# Shared scratch for one task's helper scripts (generated once).
HELPER="$BENCH/helper"
mkdir -p "$HELPER"

write_helpers() {
  cat > "$HELPER/kernel-wrapper.ts" <<'PYWRAP'
// E2E source-mode wrapper: set the build-time defines the compiled binary
// embeds (script/build.ts) as globals BEFORE loading the real CLI entry.
globalThis.OPENCODE_HOST_KERNEL_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  status: "available",
  binaryName: "hz-kernel",
  target: "linux-" + process.arch + "-gnu",
  sha256: process.env.HZ_KERNEL_SHA || "",
})
globalThis.OPENCODE_HOST_KERNEL_ASSET = process.env.HZ_KERNEL_BIN || ""
await import(process.env.HZ_CLI_ENTRY || "")
PYWRAP

  cat > "$HELPER/configure.py" <<'PYCONFIG'
import json, sys
model_id, provider_id = sys.argv[1], sys.argv[2]
profile = {
    "schemaVersion": 2,
    "profileId": "user.primary",
    "revision": "1",
    "name": "Nemotron Bench Primary",
    "description": "Primary profile pinning the live provider Nemotron model",
    "source": "user",
    "roles": ["main"],
    "purpose": "Authorize the pinned provider Nemotron direct route",
    "whenToUse": "nemotron bench",
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
    "limits": {"maxDepth": 2, "maxActiveChildren": 2, "maxTotalChildren": 2, "maxPendingMessages": 8, "maxMessageBytes": 131072},
    "maxParallelChildren": 1,
    "enabled": True,
}
print(json.dumps({
    "agent_profiles": [profile],
    "agent_profile_selectors": [{"selector": "primary", "profileId": "user.primary", "revision": "1"}],
    "primary_agent_profile_selector": "primary",
}))
PYCONFIG

  cat > "$HELPER/catalog.py" <<'PYCAT'
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

  cat > "$HELPER/parse_messages.py" <<'PYPARSE'
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
error = info.get("error")
time = info.get("time") if isinstance(info.get("time"), dict) else {}
done = bool(time.get("completed")) or info.get("finish") is not None
model_ids = set()
tin = tout = 0
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
print("STATE=%s" % ("done" if done else "running"))
print("ERROR=%s" % (json.dumps(error) if error else ""))
print("TOKENS_IN=%d" % tin)
print("TOKENS_OUT=%d" % tout)
print("MODEL_IDS=%s" % ",".join(sorted(model_ids)))
print("MSGCOUNT=%d" % len(msgs))
PYPARSE

  cat > "$HELPER/collect_events.py" <<'PYCOLLECT'
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
                        if row["type"] == "session.next.tool.failed":
                            row["error"] = str(props.get("error") or "")[:300]
                    elif row["type"] == "session.next.retried":
                        row["retry"] = True
                    elif row["type"] == "session.next.step.started":
                        m = props.get("model") if isinstance(props.get("model"), dict) else {}
                        row["model_providerID"] = m.get("providerID") or ""
                        row["model_modelID"] = m.get("modelID") or m.get("id") or ""
                    # V1 vocabulary (prebuilt CLI 0.0.0-main-20261013).
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

  cat > "$HELPER/event_metrics.py" <<'PYMETRICS'
import json, sys
path, sid, t0 = sys.argv[1], sys.argv[2], float(sys.argv[3])
deltas = 0
first_delta_t = None
first_tool_t = None
tool_open = {}
tool_latency_ms = 0.0
tool_calls = 0
tool_errors = 0
tool_err_ids = set()
seen_assistant = set()
retries = 0
steps = 0
step_models = set()
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
    if typ in ("session.next.text.delta", "message.part.delta") and (r.get("delta") or ""):
        deltas += 1
        if first_delta_t is None:
            first_delta_t = t
    elif typ == "session.next.tool.called":
        tool_calls += 1
        if first_tool_t is None:
            first_tool_t = t
        cid = r.get("callID") or ""
        if cid:
            tool_open[cid] = t
    elif typ in ("session.next.tool.success", "session.next.tool.failed"):
        if typ == "session.next.tool.failed":
            tool_errors += 1
        cid = r.get("callID") or ""
        start = tool_open.pop(cid, None)
        if start is not None:
            tool_latency_ms += max(0.0, (t - start)) * 1000.0
    elif typ == "message.part.updated" and r.get("part_type") == "tool":
        cid = r.get("callID") or ""
        status = r.get("status") or ""
        if status == "pending":
            if cid and cid not in tool_open:
                tool_open[cid] = t
                tool_calls += 1
                if first_tool_t is None:
                    first_tool_t = t
        elif status in ("completed", "error"):
            if status == "error" and cid not in tool_err_ids:
                tool_err_ids.add(cid)
                tool_errors += 1
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
print("TOOL_CALLS=%d" % tool_calls)
print("TOOL_ERRORS=%d" % tool_errors)
print("RETRIES=%d" % retries)
print("MODEL_REQUESTS=%d" % steps)
print("STEP_MODELS=%s" % ",".join(sorted(step_models)))
PYMETRICS

  cat > "$HELPER/run_tests.py" <<'PYTESTS'
# Convert SWE-bench labels ("test_x (module.Class)") to Django runtests.py
# dotted labels ("module.Class.test_x") and run them via the repo's runner.
import json, re, subprocess, sys, os
repo, venv_python, settings, out_log = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
labels_json = sys.argv[5]
labels = json.loads(labels_json)

def convert(label):
    m = re.match(r"^(?P<name>[^\s]+) \((?P<mod>[^)]+)\)$", label.strip())
    if not m:
        return label.strip()
    return "%s.%s" % (m.group("mod"), m.group("name"))

converted = [convert(l) for l in labels]
# --parallel 1 is mandatory here: Django parallel mode raises
# "TypeError: cannot pickle 'traceback' object" on py3.8 as soon as a test fails,
# which aborts the run and makes every unreported label look MISSING. Serial
# execution is slower but it actually reports pass/fail for every label.
cmd = [venv_python, "tests/runtests.py", "--settings=" + settings, "--noinput", "-v", "2", "--parallel", "1"] + converted
env = dict(os.environ)
env["PYTHONPATH"] = repo
proc = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, timeout=1500)
combined = proc.stdout + "\n--- STDERR ---\n" + proc.stderr
open(out_log, "w", encoding="utf-8").write("COMMAND: " + " ".join(cmd) + "\n\n" + combined)

result_re = re.compile(r"^(test_\S+) \(([^)]+)\) \.\.\. (.+)$", re.MULTILINE)
found = {}
for m in result_re.finditer(combined):
    name, paren, verdict = m.group(1), m.group(2), m.group(3).strip()
    # Django prints the fully qualified id in the parenthetical
    # ("test_x (module.Class.test_x)") while a SWE-bench label carries only the
    # container ("test_x (module.Class)"). Index both spellings, otherwise every
    # such label is scored MISSING and the task is misreported as env_blocked.
    found["%s (%s)" % (name, paren)] = verdict
    suffix = "." + name
    if paren.endswith(suffix):
        found.setdefault("%s (%s)" % (name, paren[: -len(suffix)]), verdict)
    else:
        found.setdefault("%s (%s%s)" % (name, paren, suffix), verdict)
passed = failed = missing = 0
failures = []
for label in labels:
    verdict = found.get(label)
    if verdict is None:
        missing += 1
        failures.append(label + ": MISSING")
    elif verdict.startswith("ok") or verdict.startswith("skipped"):
        passed += 1
    else:
        failed += 1
        failures.append(label + ": " + verdict[:60])
print("RETURNCODE=%d" % proc.returncode)
print("PASSED=%d" % passed)
print("FAILED=%d" % failed)
print("MISSING=%d" % missing)
print("FAILURES=%s" % json.dumps(failures[:20]))
PYTESTS
}

write_helpers

# ---------------------------------------------------------------------------
# Per-task pipeline.
# ---------------------------------------------------------------------------
python_version_for() {
  case "$1" in
    3.0|3.1) echo "3.8" ;;
    3.2) echo "3.9" ;;
    4.0|4.1) echo "3.11" ;;
    4.2) echo "3.11" ;;
    5.0|5.1) echo "3.12" ;;
    3.7) echo "3.11" ;;
    0.12) echo "3.8" ;;
    *) echo "3.11" ;;
  esac
}

SERVER_PID=""
APPROVER_PID=""
SSE_PID=""

task_cleanup() {
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
  SERVER_PID=""; APPROVER_PID=""; SSE_PID=""
  rm -rf "$HK_STATE" 2>/dev/null || true
}

run_one_task() {
  TASK="$1"
  T_START=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
  TASKLOG="$LOGS_ROOT/$TASK"
  mkdir -p "$TASKLOG"
  # Bind the HostKernel state dir to the kernel binary: a rebuilt kernel carries a
  # new SHA-256, and reusing the previous supervisor pin fails closed with
  # "embedded observer does not match its SHA-256 manifest".
  HK_TAG="$(printf '%s' "$TASK-$$-${KERNEL_SHA}" | md5sum | cut -c1-8)"
  HK_STATE="$ROOT/.tmp/hk-$HK_TAG"
  SERVER_PID=""; APPROVER_PID=""; SSE_PID=""

  say "==== TASK $TASK ===="
  meta=$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
task = next((t for t in data["tasks"] if t["instance_id"] == sys.argv[2]), None)
if not task:
    sys.exit(1)
print(task["repo"])
print(task["base_commit"])
print(task["version"])
print(len(task["FAIL_TO_PASS"]))
print(len(task["PASS_TO_PASS"]))
' "$TASKS_FILE" "$TASK") || {
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "" status "infra_error" \
      verified_success false failure_category "infrastructure" error "task metadata missing from tasks.json" \
      duration_ms 0 crashed false timed_out false
    return 1
 }
  REPO_NAME=$(printf '%s' "$meta" | sed -n 1p)
  BASE_COMMIT=$(printf '%s' "$meta" | sed -n 2p)
  DJANGO_VERSION=$(printf '%s' "$meta" | sed -n 3p)
  F2P_TOTAL=$(printf '%s' "$meta" | sed -n 4p)
  P2P_TOTAL=$(printf '%s' "$meta" | sed -n 5p)
  PYVER=$(python_version_for "$DJANGO_VERSION")
  say "META repo=$REPO_NAME base=${BASE_COMMIT:0:12} version=$DJANGO_VERSION py=$PYVER f2p=$F2P_TOTAL p2p=$P2P_TOTAL"

  WORK="$WORK_ROOT/$TASK-$HK_TAG"
  REPO="$WORK/repo"
  VENV="$WORK/venv"
  rm -rf "$WORK" "$HK_STATE" 2>/dev/null || true
  mkdir -p "$WORK" || return 1

  # -- 1. clone at the pinned base commit (depth-1 fetch by SHA) ------------
  git init -q "$REPO" 2>/dev/null || { say "CLONE_FAIL"; }
  git -C "$REPO" remote add origin "https://github.com/$REPO_NAME.git" 2>/dev/null
  if ! git -C "$REPO" fetch -q --depth 1 origin "$BASE_COMMIT" >> "$TASKLOG/clone.log" 2>&1; then
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "$BASE_COMMIT" \
      status "env_blocked" verified_success false failure_category "environment" \
      error "git fetch of base commit failed" duration_ms $(( $(date +%s%3N 2>/dev/null || echo 0) - T_START )) \
      crashed false timed_out false python_version "$PYVER" repo "$REPO_NAME"
    rm -rf "$WORK"
    return 1
  fi
  git -C "$REPO" checkout -q FETCH_HEAD 2>> "$TASKLOG/clone.log" || true
  say "CLONE ok $(du -sh "$REPO" 2>/dev/null | cut -f1)"

  # -- 2. cheap venv (time-boxed) -------------------------------------------
  ENV_STATUS="ok"
  ENV_ERROR=""
  if [ -z "$UV" ]; then
    ENV_STATUS="blocked"; ENV_ERROR="uv not available"
  else
    env_deadline=$((SECONDS + ENV_INSTALL_CAP_S))
    (
      "$UV" venv --python "$PYVER" "$VENV" >> "$TASKLOG/env.log" 2>&1 &&
      "$UV" pip install -q --python "$VENV/bin/python" sqlparse pytz asgiref >> "$TASKLOG/env.log" 2>&1
    ) &
    env_pid=$!
    while kill -0 "$env_pid" 2>/dev/null && [ "$SECONDS" -lt "$env_deadline" ]; do sleep 2; done
    if kill -0 "$env_pid" 2>/dev/null; then
      kill -TERM "$env_pid" 2>/dev/null || true
      ENV_STATUS="blocked"
      ENV_ERROR="env install exceeded ${ENV_INSTALL_CAP_S}s cap"
    elif [ ! -x "$VENV/bin/python" ]; then
      ENV_STATUS="blocked"
      ENV_ERROR="venv/python missing after install (see $TASKLOG/env.log)"
    fi
  fi
  if [ "$ENV_STATUS" != "ok" ]; then
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "$BASE_COMMIT" \
      status "env_blocked" verified_success false failure_category "environment" error "$ENV_ERROR" \
      duration_ms $(( $(date +%s%3N 2>/dev/null || echo 0) - T_START )) crashed false timed_out false \
      python_version "$PYVER" repo "$REPO_NAME"
    say "ENV_BLOCKED: $ENV_ERROR"
    rm -rf "$WORK"
    return 1
  fi
  say "ENV ok venv=$VENV python=$PYVER"

  # -- 3. baseline probe: first PASS_TO_PASS must pass at base ---------------
  P2P_FIRST=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
print(t["PASS_TO_PASS"][0])
' "$TASKS_FILE" "$TASK")
  settings="test_sqlite"
  # A single P2P label is a brittle environment probe: some dataset labels do
  # not resolve to a runnable test on this platform, which used to report the
  # whole task as env_blocked even though the suite was fine. Probe the first
  # four labels and accept the task as soon as one really runs and passes.
  base_passed=0
  # Labels contain spaces ("test_x (module.Class)"), so they must be read line by
  # line; word-splitting turns one label into three unusable tokens.
  while IFS= read -r probe_label; do
    [ -n "$probe_label" ] || continue
    python3 "$HELPER/run_tests.py" "$REPO" "$VENV/bin/python" "$settings" "$TASKLOG/baseline.log" \
      "$(python3 -c 'import json,sys; print(json.dumps([sys.argv[1]]))' "$probe_label")" > "$TASKLOG/baseline.env" 2>/dev/null || true
    base_passed=$(grep '^PASSED=' "$TASKLOG/baseline.env" | cut -d= -f2 || echo 0)
    [ "${base_passed:-0}" -ge 1 ] && break
  done < <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
for label in t["PASS_TO_PASS"][:8]:
    print(label)
' "$TASKS_FILE" "$TASK")
  if [ "${base_passed:-0}" -lt 1 ]; then
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "$BASE_COMMIT" \
      status "env_blocked" verified_success false failure_category "environment" \
      error "baseline PASS_TO_PASS probe failed at base commit (env cannot run the suite)" \
      duration_ms $(( $(date +%s%3N 2>/dev/null || echo 0) - T_START )) crashed false timed_out false \
      python_version "$PYVER" repo "$REPO_NAME" tests_log "$TASKLOG/baseline.log"
    say "ENV_BLOCKED: baseline probe failed (see $TASKLOG/baseline.log)"
    rm -rf "$WORK"
    return 1
  fi
  say "BASELINE ok label='$P2P_FIRST'"

  # -- 4. gold calibration: dataset gold patch through the same pipeline ----
  GOLD_F2P=0; GOLD_P2P_FAILED=""; CALIB="not_run"
  if git -C "$REPO" apply --whitespace=nowarn <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
sys.stdout.write(t["patch"])
' "$TASKS_FILE" "$TASK") >> "$TASKLOG/calibration.log" 2>&1 &&
    git -C "$REPO" apply --whitespace=nowarn <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
sys.stdout.write(t["test_patch"])
' "$TASKS_FILE" "$TASK") >> "$TASKLOG/calibration.log" 2>&1; then
    labels=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
print(json.dumps(t["FAIL_TO_PASS"] + t["PASS_TO_PASS"]))
' "$TASKS_FILE" "$TASK")
    python3 "$HELPER/run_tests.py" "$REPO" "$VENV/bin/python" "$settings" "$TASKLOG/calibration-tests.log" \
      "$labels" > "$TASKLOG/calibration.env" 2>/dev/null || true
    GOLD_F2P=$(grep '^PASSED=' "$TASKLOG/calibration.env" | cut -d= -f2 || echo 0)
    GOLD_FAILED=$(grep '^FAILED=' "$TASKLOG/calibration.env" | cut -d= -f2 || echo 0)
    GOLD_MISSING=$(grep '^MISSING=' "$TASKLOG/calibration.env" | cut -d= -f2 || echo 0)
    CALIB="gold_f2p_p2p_passed=$GOLD_F2P gold_failed=$GOLD_FAILED gold_missing=$GOLD_MISSING"
    say "CALIBRATION $CALIB (proves verification pipeline)"
  else
    CALIB="gold_patch_apply_failed"
    say "CALIBRATION failed to apply gold/test patch"
  fi
  git -C "$REPO" checkout -q -- . 2>/dev/null || true
  git -C "$REPO" clean -fdq 2>/dev/null || true

  # -- 5. boot serve with cwd = task repo -----------------------------------
  mkdir -p "$HK_STATE" "$WORK/config" "$WORK/data" "$WORK/cache" "$WORK/home" "$WORK/tmp"
  # models.dev is the provider-lifecycle authority. A cold isolated HOME has no
  # cached snapshot, so seed it from the real one instead of hand-writing a
  # catalog. HZ_PIN_CATALOG=1 is the escape hatch for a model models.dev lacks.
  MODELS_ENV=()
  if [ "${HZ_PIN_CATALOG:-0}" = "1" ]; then
    MODELS_ENV=(OPENCODE_MODELS_PATH="$WORK/catalog.json" OPENCODE_DISABLE_MODELS_FETCH=1)
  else
    if [ -f "${HZ_MODELS_SNAPSHOT:-$ORIG_HOME/.cache/opencode/models.json}" ]; then
      mkdir -p "$WORK/cache/opencode"
      cp -f "${HZ_MODELS_SNAPSHOT:-$ORIG_HOME/.cache/opencode/models.json}" "$WORK/cache/opencode/models.json"
      say "CATALOG models.dev snapshot seeded ($(wc -c < "$WORK/cache/opencode/models.json") bytes)"
    else
      say "CATALOG WARN no models.dev snapshot; relying on a live fetch"
    fi
  fi
  XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" \
    XDG_STATE_HOME="$HK_STATE" HOME="$WORK/home" TMPDIR="$WORK/tmp" \
    python3 "$HELPER/configure.py" "$MODEL_ID" "$PROVIDER_ID" > "$WORK/config/opencode.json" 2>/dev/null || true
  mkdir -p "$WORK/config/opencode"
  XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" \
    XDG_STATE_HOME="$HK_STATE" HOME="$WORK/home" TMPDIR="$WORK/tmp" \
    python3 "$HELPER/configure.py" "$MODEL_ID" "$PROVIDER_ID" > "$WORK/config/opencode/opencode.json" 2>/dev/null || true
if [ "${HZ_PIN_CATALOG:-0}" = "1" ]; then
    python3 "$HELPER/catalog.py" "$WORK/catalog.json" "$MODEL_ID" "$MODEL_PRICE_IN_PER_M" "$MODEL_PRICE_OUT_PER_M" "$PROVIDER_ID" "$PROVIDER_LABEL" "$PROVIDER_ENV_JS" "$PROVIDER_NPM" "$PROVIDER_API" "$PROVIDER_DOC" 2>/dev/null || true
fi

  OPENCODE_SERVER_PASSWORD="bench-$RANDOM-$RANDOM"
  AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\r\n')"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
  BASE_URL="http://127.0.0.1:$PORT"
  # A previous task's serve can still hold the HostKernel state directory or a
  # half-closed socket; a second boot then fails closed with "serve did not
  # become healthy" and the task is lost to the harness instead of the model.
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  sleep 1
  : > "$TASKLOG/serve.log"
  DIST_BIN="$ROOT/packages/horizoncode/dist/opencode-linux-x64/bin/opencode"
  if [ -x "$DIST_BIN" ]; then
    SERVE_MODE="dist"
    ( cd "$REPO" && exec env \
      "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
      HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 \
      HOME="$WORK/home" TMPDIR="$WORK/tmp" \
      XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$HK_STATE" \
      OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
      "${MODELS_ENV[@]+"${MODELS_ENV[@]}"}" \
      OPENCODE_CONFIG_CONTENT="$(printf '{"permission":{"read":"allow","files.read":"allow","write":"allow","files.write":"allow","bash":"allow","terminal.run":"allow"}}')" \
      OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_AUTH_CONTENT="{}" \
      "$DIST_BIN" serve --hostname 127.0.0.1 --port "$PORT" ) \
      >> "$TASKLOG/serve.log" 2>&1 &
  else
    SERVE_MODE="source"
    ( cd "$REPO" && exec env \
      "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" \
      HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 \
      HOME="$WORK/home" TMPDIR="$WORK/tmp" \
      XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$HK_STATE" \
      OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
      "${MODELS_ENV[@]+"${MODELS_ENV[@]}"}" \
      OPENCODE_CONFIG_CONTENT="$(printf '{"permission":{"read":"allow","files.read":"allow","write":"allow","files.write":"allow","bash":"allow","terminal.run":"allow"}}')" \
      OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_AUTH_CONTENT="{}" \
      HZ_KERNEL_SHA="$KERNEL_SHA" HZ_KERNEL_BIN="$KERNEL_BIN" HZ_CLI_ENTRY="$ROOT/packages/horizoncode/src/index.ts" \
      "$BUN" run "$HELPER/kernel-wrapper.ts" serve --hostname 127.0.0.1 --port "$PORT" ) \
      >> "$TASKLOG/serve.log" 2>&1 &
  fi
  SERVER_PID=$!
  healthy=""
  for _ in $(seq 1 240); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    if curl -fsS --max-time 2 "$BASE_URL/global/health" -H "Authorization: $AUTH" > "$TASKLOG/health.json" 2>/dev/null; then
      healthy=1; break
    fi
    sleep 0.5
  done
  # One retry: a cold boot occasionally loses the first health window.
  if [ -z "$healthy" ]; then
    attempts=$((${attempts:-1} + 1))
    if [ "${attempts}" -le 3 ]; then
      say "SERVE retry ${attempts}"
      kill -TERM "$SERVER_PID" 2>/dev/null || true
      sleep 2
      port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
      BASE_URL="http://127.0.0.1:$port"
      : > "$TASKLOG/serve.log"
      if [ "$SERVE_MODE" = "dist" ]; then
        ( cd "$REPO" && exec env "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 \
          HOME="$WORK/home" TMPDIR="$WORK/tmp" XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$HK_STATE" \
          OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" "${MODELS_ENV[@]+"${MODELS_ENV[@]}"}" \
          OPENCODE_CONFIG_CONTENT="$(printf '{"permission":{"read":"allow","files.read":"allow","write":"allow","files.write":"allow","bash":"allow","terminal.run":"allow"}}')" \
          OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_AUTH_CONTENT="{}" "$DIST_BIN" serve --hostname 127.0.0.1 --port "$port" ) >> "$TASKLOG/serve.log" 2>&1 &
      else
        ( cd "$REPO" && exec env "${PROVIDER_SCRUB[@]+"${PROVIDER_SCRUB[@]}"}" HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1 \
          HOME="$WORK/home" TMPDIR="$WORK/tmp" XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$HK_STATE" \
          OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" "${MODELS_ENV[@]+"${MODELS_ENV[@]}"}" \
          OPENCODE_CONFIG_CONTENT="$(printf '{"permission":{"read":"allow","files.read":"allow","write":"allow","files.write":"allow","bash":"allow","terminal.run":"allow"}}')" \
          OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_AUTH_CONTENT="{}" HZ_KERNEL_SHA="$KERNEL_SHA" HZ_KERNEL_BIN="$KERNEL_BIN" HZ_CLI_ENTRY="$ROOT/packages/horizoncode/src/index.ts" \
          "$BUN" run "$HELPER/kernel-wrapper.ts" serve --hostname 127.0.0.1 --port "$port" ) >> "$TASKLOG/serve.log" 2>&1 &
      fi
      SERVER_PID=$!
      for _ in $(seq 1 240); do
        if curl -fsS --max-time 2 "$BASE_URL/global/health" -H "Authorization: $AUTH" > "$TASKLOG/health.json" 2>/dev/null; then healthy=1; break; fi
        sleep 0.5
      done
    fi
  fi
  if [ -z "$healthy" ]; then
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "$BASE_COMMIT" \
      status "crashed" verified_success false failure_category "infrastructure" \
      error "serve did not become healthy" duration_ms $(( $(date +%s%3N 2>/dev/null || echo 0) - T_START )) \
      crashed true timed_out false python_version "$PYVER" repo "$REPO_NAME" tests_log "$TASKLOG/serve.log"
    say "CRASHED: serve unhealthy (tail: $(tail -c 200 "$TASKLOG/serve.log" 2>/dev/null | tr '\n' ' '))"
    task_cleanup
    rm -rf "$WORK"
    return 1
  fi
  say "SERVE up pid=$SERVER_PID base=$BASE_URL"

  # tool-only permission auto-approver (same idiom as the smoke)
  (
    while kill -0 "$SERVER_PID" 2>/dev/null; do
      body=$(curl -sS --max-time 3 "$BASE_URL/permission" -H "Authorization: $AUTH" 2>/dev/null || true)
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
        curl -sS --max-time 5 -X POST "$BASE_URL/permission/$id/reply" \
          -H "Authorization: $AUTH" -H 'content-type: application/json' \
          -d '{"reply":"always"}' >> "$TASKLOG/permission.log" 2>&1 || true
      done
      sleep 1
    done
  ) &
  APPROVER_PID=$!

  # -- 6. session create FIRST (initializes the instance; /event holds its
  #       headers until the instance exists), then SSE collector + prompt ----
  curl -sS --max-time 30 -o "$TASKLOG/session.json" -X POST "$BASE_URL/session" \
    -H "Authorization: $AUTH" -H 'content-type: application/json' \
    -d "{\"title\":\"bench-$TASK\"}" 2>/dev/null || true
  SID=$(python3 -c '
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("id", ""))
except Exception:
    pass
' "$TASKLOG/session.json" 2>/dev/null || true)
  if [ -z "$SID" ]; then
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "$BASE_COMMIT" \
      status "crashed" verified_success false failure_category "infrastructure" error "session create failed" \
      duration_ms $(( $(date +%s%3N 2>/dev/null || echo 0) - T_START )) crashed true timed_out false \
      python_version "$PYVER" repo "$REPO_NAME"
    task_cleanup; rm -rf "$WORK"; return 1
  fi

  # Autonomous posture through the kernel-owned mode (not a client auto-reply).
  # approvalPolicy=never removes the human round-trip inside the sandbox while
  # Guard admission, leases and receipts still apply. Compare-and-set on the
  # revision the host reports so a stale writer cannot win.
  mode_read=$(curl -sS --max-time 20 -H "Authorization: $AUTH" "$BASE_URL/config/direct-session-permission-mode?sessionID=$SID" 2>/dev/null || true)
  mode_rev=$(printf '%s' "$mode_read" | grep -o '"revision":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$mode_rev" ]; then
    curl -sS --max-time 20 -X PATCH -H "Authorization: $AUTH" -H "content-type: application/json" \
      "$BASE_URL/config/direct-session-permission-mode?sessionID=$SID" \
      -d "{\"sandboxMode\":\"danger-full-access\",\"approvalPolicy\":\"never\",\"expectedRevision\":\"$mode_rev\"}" \
      > "$TASKLOG/mode.json" 2>/dev/null || true
    say "MODE approvalPolicy=never sandboxMode=danger-full-access revision=$mode_rev"
  else
    say "MODE unavailable (continuing with the approver)"
  fi

  : > "$TASKLOG/events.jsonl"
  python3 "$HELPER/collect_events.py" "$BASE_URL" "$AUTH" "$TASKLOG/events.jsonl" > "$TASKLOG/collector.out" 2>&1 &
  SSE_PID=$!
  sleep 1

  python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
venv = sys.argv[5]
prompt = (
    (t.get("problem_statement") or t.get("prompt") or "") +
    "\n\nWork only inside this repository checkout. Do NOT modify any tests or test files; "
    "the acceptance tests are applied separately after you finish.\n\n"
    "Verification discipline (required):\n"
    "1. Make the minimal correct fix. Do not reformat, rename or refactor unrelated code.\n"
    "\nEnvironment (use exactly this):\n"
    "- Interpreter: " + venv + "/bin/python . The system python does not carry the dependencies "
    "this project needs, so a run under the system python proves nothing.\n"
    "- Test runner: tests/runtests.py --settings=test_sqlite MODULE, executed from the repository "
    "checkout root, with MODULE discovered from the files you touched.\n"
    "2. Before you finish, run the tests that cover the code you changed AND the rest of the "
    "same app or module suite, using the repository own test runner "
    "(for this project: python tests/runtests.py --settings=test_sqlite MODULE, where MODULE is "
    "discovered from the files you touched). One ad-hoc check of the reported case is not enough.\n"
    "3. If any test fails, fix the cause or revert the part that broke it. Never leave a known "
    "failure behind, and never report success from a command you did not run.\n"
    "4. If the suite cannot run at all, say exactly which command failed and why, and mark the "
    "change unverified.\n"
    "5. Finish with a short summary listing the exact commands you ran and their observed result."
)
print(json.dumps({
    "model": {"providerID": sys.argv[3], "modelID": sys.argv[4]},
    "parts": [{"type": "text", "text": prompt}],
}))
' "$TASKS_FILE" "$TASK" "$PROVIDER_ID" "$MODEL_ID" "$VENV" > "$TASKLOG/prompt-request.json" 2>"$TASKLOG/prompt-build.err" || {
    say "PROMPT_BUILD_FAILED $(head -c 300 "$TASKLOG/prompt-build.err" 2>/dev/null)"
  }
  if [ ! -s "$TASKLOG/prompt-request.json" ]; then
    say "PROMPT_BUILD_EMPTY (tasks file / selector mismatch); failing the task instead of hanging"
    STATE="env_blocked"; ERROR="prompt request could not be built"
    return 0
  fi

  T0=$(python3 -c 'import time; print(time.time())')
  say "PROMPT sending pinned $PROVIDER_ID/$MODEL_ID (timeout ${TASK_TIMEOUT_S}s)"
  prompt_status=$(curl -sS --max-time "$((TASK_TIMEOUT_S + 60))" -o "$TASKLOG/prompt-response.json" -w '%{http_code}' \
    -X POST "$BASE_URL/session/$SID/message" -H "Authorization: $AUTH" \
    -H 'content-type: application/json' --data-binary @"$TASKLOG/prompt-request.json" 2>/dev/null || echo "000")

  # -- 7. wait bounded for a settled assistant message -----------------------
  TIMED_OUT="false"
  deadline=$((SECONDS + TASK_TIMEOUT_S))
  STATE=""; ERROR=""
  while :; do
    curl -sS --max-time 10 "$BASE_URL/session/$SID/message?limit=200" \
      -H "Authorization: $AUTH" -o "$TASKLOG/messages.json" 2>/dev/null || true
    python3 "$HELPER/parse_messages.py" "$TASKLOG/messages.json" > "$TASKLOG/assistant.env" 2>/dev/null || true
    STATE=$(grep '^STATE=' "$TASKLOG/assistant.env" 2>/dev/null | cut -d= -f2- || true)
    [ "$STATE" = "done" ] && break
    [ "$STATE" = "badjson" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      TIMED_OUT="true"
      curl -sS --max-time 15 -X POST "$BASE_URL/session/$SID/abort" -H "Authorization: $AUTH" \
        -o "$TASKLOG/abort.json" 2>/dev/null || true
      break
    fi
    sleep 3
  done
  ERROR=$(grep '^ERROR=' "$TASKLOG/assistant.env" 2>/dev/null | head -n1 | cut -d= -f2- || true)
  TOKENS_IN=$(grep '^TOKENS_IN=' "$TASKLOG/assistant.env" 2>/dev/null | cut -d= -f2- || echo 0)
  TOKENS_OUT=$(grep '^TOKENS_OUT=' "$TASKLOG/assistant.env" 2>/dev/null | cut -d= -f2- || echo 0)
  MODEL_IDS=$(grep '^MODEL_IDS=' "$TASKLOG/assistant.env" 2>/dev/null | cut -d= -f2- || true)

  python3 "$HELPER/event_metrics.py" "$TASKLOG/events.jsonl" "$SID" "$T0" > "$TASKLOG/metrics.env" 2>/dev/null || true
  getm() { grep "^$1=" "$TASKLOG/metrics.env" 2>/dev/null | head -n1 | cut -d= -f2- || true; }
  STREAM_DELTAS=$(getm STREAM_DELTAS); TFA_MS=$(getm TIME_TO_FIRST_ACTION_MS)
  MODEL_LAT_MS=$(getm FIRST_DELTA_LATENCY_MS); TOOL_LAT_MS=$(getm TOOL_LATENCY_MS)
  TOOL_CALLS=$(getm TOOL_CALLS); TOOL_ERRORS=$(getm TOOL_ERRORS)
  RETRIES=$(getm RETRIES); MODEL_REQUESTS=$(getm MODEL_REQUESTS); STEP_MODELS=$(getm STEP_MODELS)

  T_END=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
  DURATION_MS=$((T_END - T_START))

  finish_task() {
    # args: status verified failure_category error patch_produced files_changed la lr tampering
    local status="$1" verified="$2" fcat="$3" err="$4" patch_produced="$5"
    local files_changed="$6" la="$7" lr="$8" tampering="$9"
    emit_record task_id "$TASK" model_id "$PROVIDER_ID/$MODEL_ID" base_commit "$BASE_COMMIT" \
      status "$status" verified_success "$verified" \
      fail_to_pass_passed "${F2P_PASSED:-0}" fail_to_pass_total "$F2P_TOTAL" \
      pass_to_pass_failed "${P2P_FAILED:-0}" \
      duration_ms "$DURATION_MS" time_to_first_action_ms "${TFA_MS:-}" model_latency_ms "${MODEL_LAT_MS:-}" \
      tool_latency_ms "${TOOL_LAT_MS:-0}" input_tokens "${TOKENS_IN:-0}" output_tokens "${TOKENS_OUT:-0}" \
      model_requests "${MODEL_REQUESTS:-0}" tool_calls "${TOOL_CALLS:-0}" tool_errors "${TOOL_ERRORS:-0}" \
      retries "${RETRIES:-0}" files_changed "${files_changed:-0}" lines_added "${la:-0}" lines_removed "${lr:-0}" \
      crashed false timed_out "$TIMED_OUT" failure_category "$fcat" error "$err" \
      python_version "$PYVER" repo "$REPO_NAME" \
      patch_path "$RUNS/$TASK.patch" events_path "$TASKLOG/events.jsonl" messages_path "$TASKLOG/messages.json" \
      tests_log "${TESTS_LOG:-}" calibration "$CALIB" test_tampering "$tampering" patch_produced "$patch_produced"
    say "RECORD $RUNS/$TASK.json status=$status category=$fcat"
  }

  # Model identity check across every assistant message + streamed steps.
  assert_model_identity() {
    local expected="$PROVIDER_ID/$MODEL_ID" bad="" id
    [ -n "$MODEL_IDS" ] || { echo "no assistant model ids reported"; return 1; }
    IFS=',' read -ra _ids <<< "$MODEL_IDS"
    for id in "${_ids[@]}"; do
      [ -z "$id" ] && continue
      case "$id" in "$expected"|"$expected:"*) ;; *) bad="$bad $id" ;; esac
    done
    if [ -n "$STEP_MODELS" ]; then
      IFS=',' read -ra _sids <<< "$STEP_MODELS"
      for id in "${_sids[@]}"; do
        [ -z "$id" ] && continue
        case "$id" in "$expected"|"$expected:"*) ;; *) bad="$bad step:$id" ;; esac
      done
    fi
    [ -z "$bad" ] || { echo "non-pinned model ids:$bad"; return 1; }
    return 0
  }

  if [ "$TIMED_OUT" = "true" ]; then
    say "TIMEOUT after ${TASK_TIMEOUT_S}s (abort sent)"
    finish_task "timeout" false "budget" "task exceeded ${TASK_TIMEOUT_S}s wall budget; session aborted" false 0 0 0 false
    task_cleanup; rm -rf "$WORK"; return 1
  fi

  id_err=$(assert_model_identity 2>&1) || true
  if [ -n "$ERROR" ]; then
    case "$ERROR" in
      *"Provider credentials are unavailable"*|*"OpenRouter free route is unavailable"*|*"managed provider requests remain unavailable"*)
        say "PROVIDER_BLOCKED: fail-closed gate rejected the credentialed send"
        finish_task "blocked" false "harness" "fail-closed provider gate: $ERROR" false 0 0 0 false
        task_cleanup; rm -rf "$WORK"; return 1 ;;
    esac
    say "ASSISTANT_ERROR: $(printf '%s' "$ERROR" | cut -c1-160)"
    finish_task "model_error" false "model" "assistant error: $ERROR" false 0 0 0 false
    task_cleanup; rm -rf "$WORK"; return 1
  fi
  if [ -n "$id_err" ]; then
    say "MODEL_IDENTITY_FAIL: $id_err"
    finish_task "model_identity_failed" false "model" "$id_err" false 0 0 0 false
    task_cleanup; rm -rf "$WORK"; return 1
  fi

  # -- 8. capture the model patch + verify ----------------------------------
  git -C "$REPO" add -A 2>/dev/null || true
  if git -C "$REPO" diff --cached --quiet 2>/dev/null; then
    say "NO_PATCH: model produced no repo changes"
    finish_task "no_patch" false "model" "model completed without producing a patch" false 0 0 0 false
    task_cleanup; rm -rf "$WORK"; return 1
  fi
  git -C "$REPO" diff --cached > "$RUNS/$TASK.patch" 2>/dev/null || true
  git -C "$REPO" diff --cached --numstat > "$TASKLOG/numstat.txt" 2>/dev/null || true
  read -r FILES_CHANGED LINES_ADDED LINES_REMOVED < <(python3 -c '
import sys
files = add = rem = 0
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    parts = line.split("\t")
    if len(parts) < 3:
        continue
    files += 1
    try:
        add += int(parts[0])
    except Exception:
        pass
    try:
        rem += int(parts[1])
    except Exception:
        pass
print(files, add, rem)
' "$TASKLOG/numstat.txt") || true
  say "PATCH files=${FILES_CHANGED:-?} +${LINES_ADDED:-?} -${LINES_REMOVED:-?} -> $RUNS/$TASK.patch"

  # Test tampering: did the model patch touch any test file that the
  # SWE-bench test_patch also touches (or any test path at all)?
  TAMPERING=$(python3 -c '
import json, sys, subprocess
repo, tasks_file, task = sys.argv[1:4]
d = json.load(open(tasks_file, encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == task)
test_files = set()
for line in (t["test_patch"] or "").splitlines():
    if line.startswith("+++ b/"):
        test_files.add(line[6:])
touched = subprocess.run(["git", "-C", repo, "diff", "--cached", "--name-only"], capture_output=True, text=True).stdout.split()
bad = [f for f in touched if f in test_files or ("/tests/" in f and f.endswith(".py"))]
print("true" if bad else "false")
if bad:
    import sys as s
    print("tampered: %s" % ",".join(bad[:10]), file=s.stderr)
' "$REPO" "$TASKS_FILE" "$TASK" 2> "$TASKLOG/tamper.txt") || TAMPERING="false"

  if [ "$TAMPERING" = "true" ]; then
    say "TEST_TAMPERING: $(head -c 200 "$TASKLOG/tamper.txt" 2>/dev/null | tr '\n' ' ')"
  fi

  git -C "$REPO" reset -q 2>/dev/null || true
  if ! git -C "$REPO" apply --whitespace=nowarn <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
sys.stdout.write(t["test_patch"])
' "$TASKS_FILE" "$TASK") >> "$TASKLOG/verify.log" 2>&1; then
    say "VERIFY: test_patch failed to apply on top of model patch"
    finish_task "verification_failed" false "verification" "test_patch does not apply on top of the model patch (model likely touched test files)" \
      true "${FILES_CHANGED:-0}" "${LINES_ADDED:-0}" "${LINES_REMOVED:-0}" "$TAMPERING"
    task_cleanup; rm -rf "$WORK"; return 1
  fi
  git -C "$REPO" apply --whitespace=nowarn "$RUNS/$TASK.patch" >> "$TASKLOG/verify.log" 2>&1 || true

  labels=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
print(json.dumps(t["FAIL_TO_PASS"] + t["PASS_TO_PASS"]))
' "$TASKS_FILE" "$TASK")
  say "VERIFY running ${F2P_TOTAL} fail-to-pass + $P2P_TOTAL pass-to-pass labels"
  python3 "$HELPER/run_tests.py" "$REPO" "$VENV/bin/python" "$settings" "$TASKLOG/verify-tests.log" \
    "$labels" > "$TASKLOG/verify.env" 2>/dev/null || true
  TESTS_LOG="$TASKLOG/verify-tests.log"
  f2p_passed_total=$(grep '^PASSED=' "$TASKLOG/verify.env" | cut -d= -f2 || echo 0)
  verify_failed=$(grep '^FAILED=' "$TASKLOG/verify.env" | cut -d= -f2 || echo 0)
  verify_missing=$(grep '^MISSING=' "$TASKLOG/verify.env" | cut -d= -f2 || echo 0)
  F2P_PASSED=0; F2P_MISSING=0; P2P_FAILED=0; P2P_MISSING=0; P2P_TOTAL=0
  eval "$(python3 - "$TASKS_FILE" "$TASK" "$TASKLOG/verify-tests.log" <<'PYSPLIT'
import json, re, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = next(x for x in d["tasks"] if x["instance_id"] == sys.argv[2])
log = open(sys.argv[3], encoding="utf-8", errors="replace").read()
result_re = re.compile(r"^(test_\S+) \(([^)]+)\) \.\.\. (.+)$", re.MULTILINE)
found = {}
for m in result_re.finditer(log):
    found["%s (%s)" % (m.group(1), m.group(2))] = m.group(3).strip()
norm = {}
for m in result_re.finditer(log):
    name, paren, verdict = m.group(1), m.group(2), m.group(3).strip()
    norm["%s (%s)" % (name, paren)] = verdict
    suffix = "." + name
    if paren.endswith(suffix):
        norm.setdefault("%s (%s)" % (name, paren[: -len(suffix)]), verdict)
def verdict(label):
    return found.get(label) or norm.get(label)
def passed(label):
    v = verdict(label)
    return v is not None and (v.startswith("ok") or v.startswith("skipped"))
def failed(label):
    v = verdict(label)
    return v is not None and not (v.startswith("ok") or v.startswith("skipped"))
def missing(label):
    return verdict(label) is None
f2p_pass = sum(1 for l in t["FAIL_TO_PASS"] if passed(l))
f2p_missing = sum(1 for l in t["FAIL_TO_PASS"] if missing(l))
p2p_fail = sum(1 for l in t["PASS_TO_PASS"] if failed(l))
p2p_missing = sum(1 for l in t["PASS_TO_PASS"] if missing(l))
print("F2P_PASSED=%d" % f2p_pass)
print("F2P_MISSING=%d" % f2p_missing)
print("P2P_FAILED=%d" % p2p_fail)
print("P2P_MISSING=%d" % p2p_missing)
print("P2P_TOTAL=%d" % len(t["PASS_TO_PASS"]))
PYSPLIT
)" || true
  say "VERIFY fail_to_pass=$F2P_PASSED/$F2P_TOTAL (missing=$F2P_MISSING) pass_to_pass_failed=$P2P_FAILED pass_to_pass_missing=$P2P_MISSING/$P2P_TOTAL (suite_failed=${verify_failed:-0} suite_missing=${verify_missing:-0})"

  VERIFIED="false"
  FCAT="model"
  STATUS="completed"
  ERR=""
  # `missing` labels are NOT regressions. The runner cannot resolve them (the
  # dataset label and the runner id differ, or the test is excluded on this
  # platform); the gold-patch calibration shows the same count, so scoring them
  # as failures invents regressions that the model did not cause. Verified still
  # requires a complete, all-green run.
  if [ "$TAMPERING" = "true" ]; then
    FCAT="verification"; ERR="model modified test files; result invalid"
  elif [ "${F2P_PASSED:-0}" -ge "$F2P_TOTAL" ] && [ "${P2P_FAILED:-0}" -eq 0 ] && [ "${P2P_MISSING:-0}" -eq 0 ] && [ "${F2P_MISSING:-0}" -eq 0 ]; then
    VERIFIED="true"; FCAT="unknown"; ERR=""
  elif [ "${F2P_MISSING:-0}" -gt 0 ]; then
    FCAT="harness"; STATUS="unverifiable"
    ERR="$F2P_MISSING of $F2P_TOTAL issue test(s) could not be executed on this platform, so the fix cannot be scored either way; the suite reported $verify_failed failures and $verify_missing unresolved labels"
  elif [ "${F2P_PASSED:-0}" -ge "$F2P_TOTAL" ] && [ "${P2P_FAILED:-0}" -eq 0 ]; then
    FCAT="verification"; STATUS="partial_verification"
    ERR="issue tests pass and no regression was observed, but $P2P_MISSING pass-to-pass label(s) could not be executed on this platform (gold patch shows the same), so the result is unverified rather than verified"
  elif [ "${F2P_PASSED:-0}" -ge "$F2P_TOTAL" ]; then
    FCAT="model"; ERR="issue tests pass but $P2P_FAILED regression test(s) failed"
  else
    FCAT="model"; ERR="issue tests incomplete: $F2P_PASSED/$F2P_TOTAL fail-to-pass passed"
  fi
  finish_task "$STATUS" "$VERIFIED" "$FCAT" "$ERR" true "${FILES_CHANGED:-0}" "${LINES_ADDED:-0}" "${LINES_REMOVED:-0}" "$TAMPERING"
  task_cleanup
  rm -rf "$WORK"
  [ "$VERIFIED" = "true" ]
}

write_helpers

say "NEMOTRON BENCH start model=$PROVIDER_ID/$MODEL_ID tasks=$SELECT timeout=${TASK_TIMEOUT_S}s"
RAN=0; VERIFIED_N=0; BLOCKED_N=0; ENV_BLOCKED_N=0; OTHER_N=0; TOTAL_IN=0; TOTAL_OUT=0
RUN_LIST=""
IFS=',' read -ra TASK_ARR <<< "$SELECT"
for t in "${TASK_ARR[@]}"; do
  [ -n "$t" ] || continue
  RAN=$((RAN + 1))
  RUN_LIST="$RUN_LIST $t"
  if run_one_task "$t"; then :; fi
  rec="$RUNS/$t.json"
  if [ -f "$rec" ]; then
    v=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(str(d.get("verified_success")).lower())' "$rec" 2>/dev/null || echo false)
    st=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("status") or "")' "$rec" 2>/dev/null || echo "")
    ti=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("input_tokens") or 0)' "$rec" 2>/dev/null || echo 0)
    to=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("output_tokens") or 0)' "$rec" 2>/dev/null || echo 0)
    TOTAL_IN=$((TOTAL_IN + ti)); TOTAL_OUT=$((TOTAL_OUT + to))
    if [ "$v" = "true" ]; then VERIFIED_N=$((VERIFIED_N + 1))
    else
      case "$st" in
        blocked) BLOCKED_N=$((BLOCKED_N + 1)) ;;
        env_blocked) ENV_BLOCKED_N=$((ENV_BLOCKED_N + 1)) ;;
        *) OTHER_N=$((OTHER_N + 1)) ;;
      esac
    fi
  else
    OTHER_N=$((OTHER_N + 1))
  fi
done

# ---------------------------------------------------------------------------
# Results sheet.
# ---------------------------------------------------------------------------
python3 - "$TASKS_FILE" "$RUNS" "$RESULTS_SHEET" "$SELECT" "$PROVIDER_ID/$MODEL_ID" \
  "$TOTAL_IN" "$TOTAL_OUT" "$MODEL_PRICE_IN_PER_M" "$MODEL_PRICE_OUT_PER_M" <<'PYSHEET'
import json, sys, os, datetime
tasks_file, runs, out, select, model, tin, tout, pin, pout = sys.argv[1:10]
data = json.load(open(tasks_file, encoding="utf-8"))
selected = [t for t in select.split(",") if t]
def rec(tid):
    p = os.path.join(runs, tid + ".json")
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None
cost = (int(tin) * float(pin) + int(tout) * float(pout)) / 1_000_000.0
lines = []
lines.append("# Nemotron SWE-bench-lite — HorizonCode results")
lines.append("")
lines.append("- Model: `%s` (pinned; verified per request, no fallback allowed)" % model)
lines.append("- Generated: %s" % datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
lines.append("- Selected tasks: %d of %d (%s)" % (len(selected), len(data["tasks"]), "all" if len(selected) == len(data["tasks"]) else "subset"))
lines.append("- Tokens: input=%d output=%d; estimated cost $%.4f (at $%s/M in, $%s/M out)" % (int(tin), int(tout), cost, pin, pout))
lines.append("")
lines.append("| # | Benchmark instance | Status | Verified | F2P passed | P2P failed | Category | Patch | Tokens in/out | Duration | Notes |")
lines.append("|---:|---|---|---|---:|---:|---|---|---:|---:|---|")
for idx, t in enumerate(data["tasks"], 1):
    tid = t["instance_id"]
    if tid not in selected:
        continue
    r = rec(tid)
    if r is None:
        row = [idx, tid, "not_run", "—", "—", "—", "—", "—", "—", "—", "no record"]
    else:
        notes = (r.get("error") or "")[:120].replace("|", "/")
        cal = (r.get("calibration") or "")
        if cal and cal != "not_run":
            notes = (notes + " | " + cal).strip(" |")[:180]
        row = [
            idx, tid,
            r.get("status") or "?",
            "yes" if r.get("verified_success") else "no",
            "%s/%s" % (r.get("fail_to_pass_passed"), r.get("fail_to_pass_total")),
            r.get("pass_to_pass_failed"),
            r.get("failure_category") or "—",
            "yes" if r.get("patch_produced") else "no",
            "%s/%s" % (r.get("input_tokens") or 0, r.get("output_tokens") or 0),
            "%ss" % (round((r.get("duration_ms") or 0) / 1000.0)),
            notes or "—",
        ]
    lines.append("| " + " | ".join(str(c) for c in row) + " |")
lines.append("")
lines.append("## How to read this sheet")
lines.append("")
lines.append("- **Verified**: all SWE-bench FAIL_TO_PASS tests pass AND no PASS_TO_PASS regression AND no test tampering.")
lines.append("- **blocked/harness**: the current tree's fail-closed provider gate rejected the real credentialed send (SecretBroker / Core RequestExecutor pinned send pending) — the model never ran; see per-task `error`.")
lines.append("- **env_blocked/environment**: the pinned repo env could not be installed or its baseline suite could not run (heavy/compiled deps).")
lines.append("- **Calibration**: each task's dataset gold patch is run through the SAME verification pipeline (see per-task `calibration` field), proving the verification side independent of the model.")
lines.append("")
lines.append("Per-task artifacts: `.tmp/nemotron-bench/runs/<task>.json`, `<task>.patch`, and per-task logs (SSE tool-call trace, messages, test logs) under `.tmp/nemotron-bench/logs/<task>/`.")
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PYSHEET

say "==== BENCH DONE ran=$RAN verified=$VERIFIED_N blocked=$BLOCKED_N env_blocked=$ENV_BLOCKED_N other=$OTHER_N tokens_in=$TOTAL_IN tokens_out=$TOTAL_OUT ===="
say "RESULTS_SHEET=$RESULTS_SHEET"
say "RUNS=$RUNS"
exit 0
