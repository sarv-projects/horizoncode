#!/usr/bin/env bash
# Offline test-suite for scripts/update/horizoncode-update.sh
# Run: bash scripts/update/test-update-semver.sh   (no network required)
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
UPDATER="$SCRIPT_DIR/horizoncode-update.sh"

export HZ_UPDATE_LIB_ONLY=1
# shellcheck source=horizoncode-update.sh
source "$UPDATER"
unset HZ_UPDATE_LIB_ONLY
# The updater enables errexit at source time; the harness needs it off.
set +e

PASS=0
FAIL=0
t() { # t <name> <expected> <actual>
    if [[ "$2" == "$3" ]]; then printf 'PASS %s (%s)\n' "$1" "$2"; PASS=$((PASS+1));
    else printf 'FAIL %s: expected %s got %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}

# ---- hz_compare_semver ----
t "1.0.0<1.0.1"        "-1" "$(hz_compare_semver 1.0.0 1.0.1)"
t "1.0.1>1.0.0"        "1"  "$(hz_compare_semver 1.0.1 1.0.0)"
t "equal"              "0"  "$(hz_compare_semver 1.2.3 1.2.3)"
t "v-prefix"           "0"  "$(hz_compare_semver v1.2.3 1.2.3)"
t "minor numeric"      "1"  "$(hz_compare_semver 1.10.0 1.9.0)"   # not lexical
t "major bump"         "1"  "$(hz_compare_semver 2.0.0 1.99.99)"
t "prerelease<release" "-1" "$(hz_compare_semver 1.0.0-rc.1 1.0.0)"
t "release>prerelease" "1"  "$(hz_compare_semver 1.0.0 1.0.0-rc.1)"
t "alpha<alpha.1"      "-1" "$(hz_compare_semver 1.0.0-alpha 1.0.0-alpha.1)"
t "alpha.1<alpha.2"    "-1" "$(hz_compare_semver 1.0.0-alpha.1 1.0.0-alpha.2)"
t "alpha<beta"         "-1" "$(hz_compare_semver 1.0.0-alpha.beta 1.0.0-beta)"
t "numeric<pre numeric" "-1" "$(hz_compare_semver 1.0.0-1 1.0.0-alpha)"  # numeric ids outrank? NO: numeric < alphanumeric
t "rc.1<rc.2"          "-1" "$(hz_compare_semver 1.0.0-rc.1 1.0.0-rc.2)"
t "build metadata ign" "0"  "$(hz_compare_semver 1.0.0+build.1 1.0.0+build.2)"
t "invalid a"          "2"  "$(hz_compare_semver nonsense 1.0.0 || printf '2')"
t "invalid b"          "2"  "$(hz_compare_semver 1.0 nonsense || printf '2')"

# ---- hz_parse_latest_version ----
t "gh-json-tag" "v1.19.0" "$(hz_parse_latest_version '{"tag_name":"v1.19.0","name":"Release 1.19.0"}')"
t "gh-json-name" "1.19.1" "$(hz_parse_latest_version '{"url":"x","name":"1.19.1"}')"
t "bare-text" "2.0.0" "$(hz_parse_latest_version '2.0.0')"
if hz_parse_latest_version '{"no":"version"}' >/dev/null 2>&1; then t "garbage-rejected" "fail" "ok"; else t "garbage-rejected" "fail" "fail"; fi

# ---- check subcommand: offline endpoint (fails soft, exits 0) ----
out=$(bash "$UPDATER" check --endpoint https://127.0.0.1:1/latest --timeout 1 --json 2>&1)
rc=$?
t "check-offline-exit0" "0" "$rc"
[[ "$out" == *'"status":"check-failed"'* ]] && { t "check-offline-status" "check-failed" "check-failed"; } || { t "check-offline-status" "check-failed" "$out"; }

# ---- apply gating: refuses without the explicit unsigned ack (DEC-V1-12) ----
out=$(env -u HORIZONCODE_ALLOW_UNSIGNED_UPDATE -u HORIZONCODE_UPDATE_SHA256 bash "$UPDATER" apply --version 9.9.9 --sha256 "$(printf 'b%.0s' {1..64})" 2>&1)
rc=$?
[[ $rc -ne 0 ]] && { t "apply-without-ack-refused" "nonzero" "nonzero"; } || { t "apply-without-ack-refused" "nonzero" "0"; }
[[ "$out" == *"DEC-V1-12"* ]] && { t "apply-ack-message" "DEC-V1-12" "DEC-V1-12"; } || { t "apply-ack-message" "DEC-V1-12" "$out"; }

# ---- apply with ack but no pin: refused ----
out=$(env HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 -u HORIZONCODE_UPDATE_SHA256 bash "$UPDATER" apply --version 9.9.9 2>&1)
rc=$?
[[ $rc -ne 0 ]] && { t "apply-without-pin-refused" "nonzero" "nonzero"; } || { t "apply-without-pin-refused" "nonzero" "0"; }

# ---- apply with ack + pin but bad pin format: refused ----
out=$(env HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 bash "$UPDATER" apply --version 9.9.9 --sha256 deadbeef 2>&1)
rc=$?
[[ $rc -ne 0 ]] && { t "apply-bad-pin-refused" "nonzero" "nonzero"; } || { t "apply-bad-pin-refused" "nonzero" "0"; }

# ---- unknown subcommand: refused ----
out=$(bash "$UPDATER" frobnicate 2>&1)
rc=$?
[[ $rc -ne 0 ]] && { t "unknown-subcommand-refused" "nonzero" "nonzero"; } || { t "unknown-subcommand-refused" "nonzero" "0"; }

echo ""
echo "update tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
