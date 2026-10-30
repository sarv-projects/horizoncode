#!/usr/bin/env bash
# ============================================================================
# HorizonCode RAM profiler (Lead 7 / perf)
#
# Launches `horizoncode serve` (falls back to the repo source entry via bun),
# then samples PSS/RSS of the whole server process tree through three phases:
#   idle   - server running, no traffic
#   session- POST /session (create a session)
#   turn   - POST /session/{id}/message (one model turn; may fail without a
#            configured provider - the RAM cost of the attempt is still measured)
#
# Sampling: /proc/<pid>/smaps_rollup (Pss/Rss) with /proc/<pid>/status VmRSS
# fallback. Reports per component (server / kernel / other):
#   - steady-state PSS MB (mean of the last 3 samples of the phase)
#   - peak PSS MB and peak RSS MB of the phase
# plus the biggest resident mappings at the peak of the heaviest phase.
#
# Usage: scripts/perf/ram-usage.sh [--interval S] [--idle S] [--port N]
# Env:   HORIZONCODE_BIN (override CLI), HORIZONCODE_BUN (default ~/.bun/bin/bun)
# ============================================================================
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$SCRIPT_DIR/../.." && pwd -P)

INTERVAL=0.1
IDLE_SECONDS=12
SESSION_SECONDS=8
TURN_TIMEOUT=90
PORT=17071

while [[ $# -gt 0 ]]; do
    case "$1" in
        --interval) INTERVAL=${2:?}; shift 2 ;;
        --idle) IDLE_SECONDS=${2:?}; shift 2 ;;
        --port) PORT=${2:?}; shift 2 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

BUN="${HORIZONCODE_BUN:-$HOME/.bun/bin/bun}"
if [[ -n "${HORIZONCODE_BIN:-}" ]]; then
    CLI=("$HORIZONCODE_BIN")
elif command -v horizoncode >/dev/null 2>&1; then
    CLI=("$(command -v horizoncode)")
elif [[ -x "$BUN" && -f "$REPO/packages/horizoncode/src/index.ts" ]]; then
    CLI=("$BUN" "$REPO/packages/horizoncode/src/index.ts")
else
    echo "No HorizonCode CLI found (set HORIZONCODE_BIN or install horizoncode)." >&2
    exit 1
fi

WORK=$(mktemp -d /tmp/hz-ram-usage.XXXXXX)
SERVER_LOG="$WORK/server.log"
SAMPLES="$WORK/samples.csv"   # phase,component,pss_kb,rss_kb
PEAKS="$WORK/peaks.csv"       # phase,pid,component,pss_kb,rss_kb,cmd
mkdir -p "$WORK"
: > "$SAMPLES"
: > "$PEAKS"
echo "phase,component,pss_kb,rss_kb" >> "$SAMPLES"
echo "phase,pid,component,pss_kb,rss_kb,cmd" >> "$PEAKS"

SERVER_PID=""
cleanup() {
    local rc=$?
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
        sleep 1
        kill -KILL -- "-$SERVER_PID" 2>/dev/null || kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
    echo ""
    echo "raw samples: $SAMPLES (server log: $SERVER_LOG)"
    exit $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------- launch ---
echo "== HorizonCode RAM profiler =="
echo "repo:     $REPO"
echo "cli:      ${CLI[*]}"
echo "work dir: $WORK"
echo ""
echo "launching: ${CLI[*]} serve --port $PORT --hostname 127.0.0.1"
setsid "${CLI[@]}" serve --port "$PORT" --hostname 127.0.0.1 > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "server pid: $SERVER_PID"

up=false
for _ in $(seq 1 90); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "server exited during startup; log tail:" >&2
        tail -30 "$SERVER_LOG" >&2
        exit 1
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/doc" || true)
    if [[ "$code" != "000" && -n "$code" ]]; then up=true; break; fi
    sleep 1
done
if [[ "$up" != true ]]; then
    echo "server did not become reachable; log tail:" >&2
    tail -30 "$SERVER_LOG" >&2
    exit 1
fi
echo "server up (HTTP $code on /doc)"

# --------------------------------------------------------------- sampling ---
classify() {
    local cmdline=$1
    case "$cmdline" in
        *kernel*|*hz-kernel*|*host_kernel*|*session_supervisor*) printf 'kernel' ;;
        *serve*) printf 'server' ;;
        *) printf 'other' ;;
    esac
}

# tree_pids: server pid + all descendants (via ps pid/ppid snapshot)
tree_pids() {
    ps -eo pid=,ppid= | awk -v root="$SERVER_PID" '
        { parent[$1] = $2 }
        END {
            for (p in parent) {
                cur = p
                while (cur != 1 && cur in parent) {
                    if (cur == root) { print p; break }
                    cur = parent[cur]
                }
            }
            print root
        }'
}

snapshot() {
    local phase=$1
    local pids pid cmdline component pss rss
    pids=$(tree_pids)
    for pid in $pids; do
        [[ -r "/proc/$pid/smaps_rollup" || -r "/proc/$pid/status" ]] || continue
        cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-160)
        [[ -n "$cmdline" ]] || cmdline="[pid $pid]"
        component=$(classify "$cmdline")
        pss=""; rss=""
        if [[ -r "/proc/$pid/smaps_rollup" ]]; then
            pss=$(awk '/^Pss:/ {print $2}' "/proc/$pid/smaps_rollup" 2>/dev/null || true)
            rss=$(awk '/^Rss:/ {print $2}' "/proc/$pid/smaps_rollup" 2>/dev/null || true)
        fi
        if [[ -z "$rss" && -r "/proc/$pid/status" ]]; then
            rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)
        fi
        [[ -n "$rss" ]] || continue
        pss=${pss:-$rss}
        printf '%s,%s,%s,%s\n' "$phase" "$component" "$pss" "$rss" >> "$SAMPLES"
        printf '%s,%s,%s,%s,%s\n' "$phase" "$pid" "$component" "$pss" "$rss" "${cmdline//,/;}" >> "$PEAKS"
    done
}

run_phase() {
    local phase=$1 seconds=$2
    local steps
    steps=$(awk -v s="$seconds" -v i="$INTERVAL" 'BEGIN { printf "%d", (s / i) }')
    local step
    step=0
    while (( step < steps )); do
        snapshot "$phase"
        sleep "$INTERVAL"
        step=$((step + 1))
    done
    echo "phase '$phase' sampled for ${seconds}s (interval ${INTERVAL}s)"
}

# ----------------------------------------------------------------- HTTP ----
BASE="http://127.0.0.1:$PORT"
DIR_HEADER="x-opencode-directory: $REPO"
SESSION_ID=""

phase_session() {
    local resp code
    resp=$(curl -s -w '\n%{http_code}' --max-time 30 -X POST "$BASE/session" \
        -H "$DIR_HEADER" -H 'content-type: application/json' -d '{}' || true)
    code=$(printf '%s' "$resp" | tail -1)
    SESSION_ID=$(printf '%s' "$resp" | sed '$d' | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    echo "POST /session -> HTTP ${code:-000} session=${SESSION_ID:-<none>}"
}

TURN_RESULT=""
phase_turn() {
    if [[ -z "$SESSION_ID" ]]; then
        TURN_RESULT="skipped (no session id)"
        echo "turn skipped: no session"
        return 0
    fi
    local body resp code
    body=$(printf '{"parts":[{"type":"text","text":"Reply with the single word OK."}]}')
    resp=$(curl -s -w '\n%{http_code}' --max-time "$TURN_TIMEOUT" -X POST "$BASE/session/$SESSION_ID/message" \
        -H "$DIR_HEADER" -H 'content-type: application/json' -d "$body" || true)
    code=$(printf '%s' "$resp" | tail -1)
    TURN_RESULT="POST /session/{id}/message -> HTTP ${code:-000}"
    echo "$TURN_RESULT"
}

# ------------------------------------------------------------- run phases ---
run_phase idle "$IDLE_SECONDS"
phase_session
run_phase session "$SESSION_SECONDS"
phase_turn
run_phase turn 6

# ---------------------------------------------------------------- report ---
echo ""
echo "== RAM report (PSS is the proportional-set-size headline number) =="
awk -F, '
    NR == 1 { next }
    {
        phase = $1; comp = $2; pss = $3 + 0; rss = $4 + 0
        n[phase SUBSEP comp]++
        sum[phase SUBSEP comp] += pss
        if (pss > peakp[phase SUBSEP comp]) peakp[phase SUBSEP comp] = pss
        if (rss > peakr[phase SUBSEP comp]) peakr[phase SUBSEP comp] = rss
        if (pss > peakpt[phase]) peakpt[phase] = pss
        if (rss > peakrt[phase]) peakrt[phase] = rss
    }
    END {
        printf "%-8s %-8s %12s %12s %12s\n", "PHASE", "COMP", "STEADY_MB", "PEAKPSS_MB", "PEAKRSS_MB"
        for (key in peakp) {
            split(key, parts, SUBSEP)
            phase = parts[1]; comp = parts[2]
            steady = (n[key] >= 3) ? (sum[key] - 0) / n[key] : sum[key] / n[key]
            # steady-state = mean of the whole phase (idle noise is tiny)
            printf "%-8s %-8s %12.1f %12.1f %12.1f\n", phase, comp, steady / 1024, peakp[key] / 1024, peakr[key] / 1024
        }
        for (phase in peakpt) {
            printf "%-8s %-8s %12s %12.1f %12.1f\n", phase, "TOTAL", "-", peakpt[phase] / 1024, peakrt[phase] / 1024
        }
    }
' "$SAMPLES" | sort

echo ""
echo "== heaviest process at each phase peak (top mappings by Rss) =="
awk -F, 'NR > 1 { key = $1 SUBSEP $3; if ($4 + 0 > best[key]) { best[key] = $4 + 0; pid[key] = $2 } }
    END { for (key in best) { split(key, p, SUBSEP); printf "%s %s %s\n", p[1], pid[key], best[key] } }' "$PEAKS" |
while read -r phase pid pss; do
    [[ -r "/proc/$pid/smaps" ]] || continue
    echo ""
    echo "--- $phase: pid $pid (peak PSS ${pss} kB) ---"
    head -1 "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ' | cut -c1-140; echo ""
    awk '
        /^[0-9a-f]+-[0-9a-f]+ / { if (NF >= 6) name = $6; else name = "[anon]" }
        /^Rss:/ { rss[name] += $2 }
        END { for (m in rss) printf "%10d kB  %s\n", rss[m], m }
    ' "/proc/$pid/smaps" 2>/dev/null | sort -rn | head -8
done

echo ""
echo "server log: $SERVER_LOG"
echo "turn result: ${TURN_RESULT:-n/a}"
