#!/usr/bin/env bash
# ============================================================================
# HorizonCode update helper — CHECK + LOCAL_ONLY_UNSIGNED upgrade path
#
# Governance: arch_V1/17-GOVERNANCE-DECISIONS.md DEC-V1-12 DEFERRED signing
# and automatic updates beyond V1. Therefore:
#   * `check`  — metadata-only (version string) fetch. Safe, no code executed.
#   * `apply`  — NEVER runs by default. Requires the explicit opt-in ack
#                HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 AND a 64-hex digest pin
#                (--sha256 / HORIZONCODE_UPDATE_SHA256). Refuses otherwise.
#   * `local`  — LOCAL_ONLY_UNSIGNED upgrade from a local checkout rebuild.
#                No remote code ever involved. Preferred upgrade path.
#
# Subcommands:
#   hz-update check  [--current <ver>] [--endpoint <url>] [--timeout <s>] [--json]
#   hz-update local  --from-repo <dir> [--current <ver>]
#   hz-update apply  --sha256 <64hex> --version <ver> [--endpoint-base <url>]
#                    [--asset-name <name>]   # requires HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1
#
# Env:
#   HORIZONCODE_UPDATE_ENDPOINT      metadata endpoint (default GitHub latest)
#   HORIZONCODE_UPDATE_SHA256        digest pin for apply
#   HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1   explicit opt-in ack for apply
#   HORIZONCODE_UPDATE_INSTALL_DIR   forwarded to the installer
#
# HZ_UPDATE_LIB_ONLY=1 sources this file for its library functions without
# running main (used by the offline test-suite).
# ============================================================================
set -euo pipefail
export LC_ALL=C

HORIZONCODE_VERSION_DEFAULT_ENDPOINT="https://api.github.com/repos/sarv-projects/horizoncode/releases/latest"
HORIZONCODE_VERSION_RELEASE_BASE="https://github.com/sarv-projects/horizoncode/releases/download"

_hz_warn() { printf '%s\n' "$*" >&2; }
_hz_die()  { printf 'Error: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- semver core --
# Accepts optional leading "v", core x.y.z plus optional -prerelease.
# Build metadata (+...) is ignored for precedence.
hz_parse_semver() {
    local input=${1:-} core pre rest
    [[ "$input" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)(-([0-9A-Za-z.-]+))?(\+.*)?$ ]] || return 1
    HZ_SEMVER_MAJOR=$((10#${BASH_REMATCH[1]}))
    HZ_SEMVER_MINOR=$((10#${BASH_REMATCH[2]}))
    HZ_SEMVER_PATCH=$((10#${BASH_REMATCH[3]}))
    HZ_SEMVER_PRE="${BASH_REMATCH[5]}"
    return 0
}

_hz_pre_ident_cmp() {
    # $1/$2 are single dot-separated prerelease identifiers.
    local a=$1 b=$2
    if [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]]; then
        if (( 10#$a < 10#$b )); then printf -- '-1'; return; fi
        if (( 10#$a > 10#$b )); then printf -- '1'; return; fi
        printf -- '0'; return
    fi
    if [[ "$a" =~ ^[0-9]+$ ]]; then printf -- '-1'; return; fi
    if [[ "$b" =~ ^[0-9]+$ ]]; then printf -- '1'; return; fi
    if [[ "$a" < "$b" ]]; then printf -- '-1'; return; fi
    if [[ "$a" > "$b" ]]; then printf -- '1'; return; fi
    printf -- '0'
}

# hz_compare_semver <a> <b> -> stdout: -1 (a<b) | 0 (equal) | 1 (a>b); 2 on parse error
hz_compare_semver() {
    local a=${1:-} b=${2:-}
    hz_parse_semver "$a" || return 2
    local aM=$HZ_SEMVER_MAJOR am=$HZ_SEMVER_MINOR ap=$HZ_SEMVER_PATCH apre=$HZ_SEMVER_PRE
    hz_parse_semver "$b" || return 2
    local bM=$HZ_SEMVER_MAJOR bm=$HZ_SEMVER_MINOR bp=$HZ_SEMVER_PATCH bpre=$HZ_SEMVER_PRE

    if (( aM != bM )); then (( aM < bM )) && printf -- '-1' || printf -- '1'; return 0; fi
    if (( am != bm )); then (( am < bm )) && printf -- '-1' || printf -- '1'; return 0; fi
    if (( ap != bp )); then (( ap < bp )) && printf -- '-1' || printf -- '1'; return 0; fi

    # A release outranks any of its prereleases.
    if [[ -z "$apre" && -z "$bpre" ]]; then printf -- '0'; return 0; fi
    if [[ -z "$apre" ]]; then printf -- '1'; return 0; fi
    if [[ -z "$bpre" ]]; then printf -- '-1'; return 0; fi

    local IFS='.'
    read -r -a a_ids <<< "$apre"
    read -r -a b_ids <<< "$bpre"
    local i n cmp
    n=${#a_ids[@]}
    if (( ${#b_ids[@]} < n )); then n=${#b_ids[@]}; fi
    for (( i = 0; i < n; i++ )); do
        cmp=$(_hz_pre_ident_cmp "${a_ids[$i]}" "${b_ids[$i]}")
        if [[ "$cmp" != "0" ]]; then printf '%s' "$cmp"; return 0; fi
    done
    if (( ${#a_ids[@]} < ${#b_ids[@]} )); then printf -- '-1'; return 0; fi
    if (( ${#a_ids[@]} > ${#b_ids[@]} )); then printf -- '1'; return 0; fi
    printf -- '0'
}

# ---------------------------------------------------- latest-version parse --
# Accepts GitHub release JSON (tag_name/name) or a bare "x.y.z" text body.
hz_parse_latest_version() {
    local text=${1:-} value=""
    if [[ "$text" =~ \"tag_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
        value="${BASH_REMATCH[1]}"
    elif [[ "$text" =~ \"name\"[[:space:]]*:[[:space:]]*\"v?([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?)\" ]]; then
        value="${BASH_REMATCH[1]}"
    elif [[ "$text" =~ ^[[:space:]]*v?([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?)[[:space:]]*$ ]]; then
        value="${BASH_REMATCH[1]}"
    else
        return 1
    fi
    hz_parse_semver "$value" || return 1
    printf '%s' "$value"
}

# -------------------------------------------------------------- check main --
hz_cmd_check() {
    local current="" endpoint="${HORIZONCODE_UPDATE_ENDPOINT:-$HORIZONCODE_VERSION_DEFAULT_ENDPOINT}"
    local timeout=8 json=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --current) current=${2:-}; shift 2 ;;
            --endpoint) endpoint=${2:-}; shift 2 ;;
            --timeout) timeout=${2:-}; shift 2 ;;
            --json) json=true; shift ;;
            *) _hz_die "check: unknown option '$1'" ;;
        esac
    done
    command -v curl >/dev/null 2>&1 || _hz_die "curl is required for update checks."
    local body
    if ! body=$(curl -fsSL --proto '=https' --max-time "$timeout" -H 'Accept: application/json' "$endpoint" 2>/dev/null); then
        if [[ "$json" == true ]]; then
            printf '{"status":"check-failed","endpoint":"%s"}\n' "$endpoint"
        else
            _hz_warn "Update check failed (unreachable endpoint: $endpoint). HorizonCode keeps running; automatic updates are off by design (DEC-V1-12)."
        fi
        exit 0
    fi
    local latest
    if ! latest=$(hz_parse_latest_version "$body"); then
        _hz_warn "Update check: endpoint did not yield a parseable version ($endpoint)."
        exit 0
    fi
    current="${current:-$(hz_detect_current_version)}"
    local cmp
    cmp=$(hz_compare_semver "$current" "$latest") || cmp="incomparable"
    local status="up-to-date"
    case "$cmp" in
        -1) status="update-available" ;;
        0) status="up-to-date" ;;
        1) status="ahead" ;;
        *) status="incomparable" ;;
    esac
    if [[ "$json" == true ]]; then
        printf '{"status":"%s","current":"%s","latest":"%s","endpoint":"%s","auto":"disabled-by-policy"}\n' \
            "$status" "$current" "$latest" "$endpoint"
    else
        printf 'current: %s\nlatest:  %s (%s)\nstatus:  %s\n' "$current" "$latest" "$endpoint" "$status"
        if [[ "$status" == "update-available" ]]; then
            printf 'automatic updates are DISABLED by policy (DEC-V1-12). Upgrade explicitly:\n'
            printf '  horizoncode update local --from-repo <checkout>   # LOCAL_ONLY_UNSIGNED (preferred)\n'
            printf '  HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 horizoncode update apply --sha256 <pin> --target-version %s\n' "$latest"
        fi
    fi
}

hz_detect_current_version() {
    if [[ -n "${HORIZONCODE_CURRENT_VERSION:-}" ]]; then printf '%s' "$HORIZONCODE_CURRENT_VERSION"; return 0; fi
    local repo ver=""
    repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd -P || true)
    if [[ -n "$repo" && -f "$repo/packages/horizoncode/package.json" ]]; then
        ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/packages/horizoncode/package.json" | head -1)
    fi
    printf '%s' "${ver:-unknown}"
}

# --------------------------------------------------------------- local main --
hz_cmd_local() {
    local from_repo="" current=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --from-repo) from_repo=${2:-}; shift 2 ;;
            --current) current=${2:-}; shift 2 ;;
            *) _hz_die "local: unknown option '$1'" ;;
        esac
    done
    [[ -n "$from_repo" ]] || _hz_die "local: --from-repo <dir> is required."
    local script_dir installer
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
    installer="$script_dir/../install/horizoncode-install.sh"
    [[ -x "$installer" ]] || _hz_die "installer not found next to this script: $installer"
    _hz_warn "LOCAL_ONLY_UNSIGNED upgrade from checkout: $from_repo (no remote code is fetched; DEC-V1-12)."
    local before="${current:-$(hz_detect_current_version)}"
    bash "$installer" --from-repo "$from_repo" ${HORIZONCODE_INSTALL_DIR:+--dir "$HORIZONCODE_INSTALL_DIR"}
    printf 'upgrade applied from local checkout (source version %s; installed binary was digest-verified by the installer).\n' "$before"
}

# --------------------------------------------------------------- apply main --
hz_cmd_apply() {
    local pin="${HORIZONCODE_UPDATE_SHA256:-}" version="" endpoint_base="$HORIZONCODE_VERSION_RELEASE_BASE" asset_name=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --sha256) pin=${2:-}; shift 2 ;;
            --version) version=${2:-}; shift 2 ;;
            --endpoint-base) endpoint_base=${2:-}; shift 2 ;;
            --asset-name) asset_name=${2:-}; shift 2 ;;
            *) _hz_die "apply: unknown option '$1'" ;;
        esac
    done
    # Fail closed: unsigned remote upgrade requires an explicit ack (DEC-V1-12).
    if [[ "${HORIZONCODE_ALLOW_UNSIGNED_UPDATE:-}" != "1" ]]; then
        _hz_die "apply refuses to run: automatic/remote upgrades are deferred beyond V1 (DEC-V1-12). Set HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 to acknowledge the UNSIGNED upgrade, or use 'hz-update local --from-repo <checkout>'."
    fi
    [[ -n "$version" ]] || _hz_die "apply: --version is required."
    [[ "$pin" =~ ^[0-9a-fA-F]{64}$ ]] || _hz_die "apply: a 64-hex digest pin is required (--sha256 or HORIZONCODE_UPDATE_SHA256)."
    [[ -n "$asset_name" ]] || asset_name="horizoncode-v${version}-linux-$(uname -m)"
    local script_dir installer
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
    installer="$script_dir/../install/horizoncode-install.sh"
    [[ -x "$installer" ]] || _hz_die "installer not found next to this script: $installer"
    _hz_warn "UNSIGNED REMOTE UPGRADE acknowledged (DEC-V1-12 defers signing). Digest pin: ${pin:0:12}…"
    bash "$installer" --remote --version "$version" --asset-name "$asset_name" \
        --endpoint-base "$endpoint_base" --sha256 "$pin" \
        ${HORIZONCODE_INSTALL_DIR:+--dir "$HORIZONCODE_INSTALL_DIR"}
}

hz_main() {
    local sub=${1:-check}
    shift || true
    case "$sub" in
        check) hz_cmd_check "$@" ;;
        local) hz_cmd_local "$@" ;;
        apply) hz_cmd_apply "$@" ;;
        -h|--help|help)
            printf 'HorizonCode update helper (check | local | apply). Automatic updates are disabled by policy (DEC-V1-12).\n'
            ;;
        *) _hz_die "unknown subcommand '$sub' (expected check|local|apply)" ;;
    esac
}

if [[ "${HZ_UPDATE_LIB_ONLY:-0}" != "1" ]]; then
    hz_main "$@"
fi
