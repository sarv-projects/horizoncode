#!/usr/bin/env bash
# Offline test-suite for scripts/install/horizoncode-install.sh
# Run: bash scripts/install/test-horizoncode-install.sh
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
INSTALLER="$SCRIPT_DIR/horizoncode-install.sh"

TMP=$(mktemp -d /tmp/hz-install-test.XXXXXX)
trap 'rm -rf -- "$TMP"' EXIT

PASS=0
FAIL=0

check() { # check <name> <expected_exit> <actual_exit> [grep_pattern_in_output]
    local name=$1 expected=$2 actual=$3 pattern=${4:-}
    if [[ "$expected" == "fail-nonzero" ]]; then
        if [[ "$actual" -ne 0 ]]; then printf 'PASS %s (exit %s)\n' "$name" "$actual"; PASS=$((PASS+1)); return; fi
    elif [[ "$actual" -ne "$expected" ]]; then
        printf 'FAIL %s: expected exit %s got %s\n' "$name" "$expected" "$actual"; FAIL=$((FAIL+1)); return
    fi
    printf 'PASS %s (exit %s)\n' "$name" "$actual"; PASS=$((PASS+1))
}

run() { # run <outname> args... ; sets OUT and RC (env prefix via envs array)
    local outname=$1; shift
    "$@" > "$TMP/$outname.out" 2> "$TMP/$outname.err"
    RC=$?
    OUT=$(cat "$TMP/$outname.out" "$TMP/$outname.err")
}

FAKE=/bin/true
SHA=$(sha256sum -- "$FAKE" | cut -d' ' -f1)
export HOME="$TMP/home"
mkdir -p "$HOME"
INSTALL_DIR="$TMP/install"

# 1. no source => fail closed
run t1 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --no-modify-path
check "no-source-fails-closed" 1 "$RC"
[[ "$OUT" == *"no install source"* ]] && { echo "PASS no-source-message"; PASS=$((PASS+1)); } || { echo "FAIL no-source-message"; FAIL=$((FAIL+1)); }

# 2. --binary without sha => fail
run t2 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --no-modify-path
check "binary-without-sha-fails" 1 "$RC"

# 3. wrong sha => fail
run t3 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$(printf 'a%.0s' {1..64})" --no-modify-path
check "wrong-sha-fails" 1 "$RC"
[[ "$OUT" == *"mismatch"* ]] && { echo "PASS mismatch-message"; PASS=$((PASS+1)); } || { echo "FAIL mismatch-message"; FAIL=$((FAIL+1)); }

# 4. unknown flag => fail
run t4 bash "$INSTALLER" --bogus
check "unknown-flag-fails" 1 "$RC"

# 5. happy path install
run t5 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$SHA" --no-modify-path
check "happy-path-install" 0 "$RC"
[[ -x "$INSTALL_DIR/horizoncode" ]] && { echo "PASS canonical-exists"; PASS=$((PASS+1)); } || { echo "FAIL canonical-exists"; FAIL=$((FAIL+1)); }
[[ ( -L "$INSTALL_DIR/hzcode" || -f "$INSTALL_DIR/hzcode" ) ]] && { echo "PASS alias-exists"; PASS=$((PASS+1)); } || { echo "FAIL alias-exists"; FAIL=$((FAIL+1)); }
installed_sha=$(sha256sum -- "$INSTALL_DIR/horizoncode" | cut -d' ' -f1)
[[ "$installed_sha" == "$SHA" ]] && { echo "PASS installed-digest"; PASS=$((PASS+1)); } || { echo "FAIL installed-digest"; FAIL=$((FAIL+1)); }

# 6. idempotent rerun => no-op success
run t6 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$SHA" --no-modify-path
check "idempotent-rerun" 0 "$RC"
[[ "$OUT" == *"already installed"* ]] && { echo "PASS idempotent-message"; PASS=$((PASS+1)); } || { echo "FAIL idempotent-message: $OUT"; FAIL=$((FAIL+1)); }

# 7. dry-run writes nothing
DRY_DIR="$TMP/dry-install"
run t7 env HORIZONCODE_INSTALL_DIR="$DRY_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$SHA" --no-modify-path --dry-run
check "dry-run-exit-0" 0 "$RC"
[[ ! -e "$DRY_DIR" ]] && { echo "PASS dry-run-writes-nothing"; PASS=$((PASS+1)); } || { echo "FAIL dry-run-writes-nothing"; FAIL=$((FAIL+1)); }

# 8. non-Linux platform rejected
run t8 env HZ_UNAME_S=Darwin HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$SHA" --no-modify-path
check "non-linux-rejected" 1 "$RC"

# 9. unsupported arch rejected
run t9 env HZ_UNAME_M=riscv64 HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$SHA" --no-modify-path
check "bad-arch-rejected" 1 "$RC"

# 10. multiple sources rejected
run t10 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --binary "$FAKE" --sha256 "$SHA" --remote --version 1.0.0 --no-modify-path
check "multi-source-rejected" 1 "$RC"

# 11. remote without digest pin => fail closed (DEC-V1-12)
run t11 env HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --remote --version 1.0.0 --no-modify-path
check "remote-without-pin-fails" 1 "$RC"
[[ "$OUT" == *"DEC-V1-12"* ]] && { echo "PASS dec-v1-12-mention"; PASS=$((PASS+1)); } || { echo "FAIL dec-v1-12-mention"; FAIL=$((FAIL+1)); }

# 12. remote without explicit version => fail closed
run t12 env HORIZONCODE_INSTALL_SHA256="$SHA" HORIZONCODE_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALLER" --remote --no-modify-path
check "remote-without-version-fails" 1 "$RC"

# 13. --launcher from a checkout installs a bun dev launcher
FAKE_REPO="$TMP/checkout"
mkdir -p "$FAKE_REPO"
echo '{"name":"horizoncode-probe"}' > "$FAKE_REPO/package.json"
LAUNCH_DIR="$TMP/launch-install"
run t13 env HORIZONCODE_BUN=/bin/bash HORIZONCODE_INSTALL_DIR="$LAUNCH_DIR" bash "$INSTALLER" --from-repo "$FAKE_REPO" --launcher --no-modify-path
check "launcher-install" 0 "$RC"
if grep -q "$FAKE_REPO/packages/horizoncode/src/index.ts" "$LAUNCH_DIR/horizoncode" 2>/dev/null; then
    echo "PASS launcher-pins-repo"; PASS=$((PASS+1))
else
    echo "FAIL launcher-pins-repo"; FAIL=$((FAIL+1))
fi

# 14. repo without prebuilt binary and without --launcher => fail
run t14 env HORIZONCODE_INSTALL_DIR="$LAUNCH_DIR" bash "$INSTALLER" --from-repo "$FAKE_REPO" --no-modify-path
check "repo-without-binary-fails" 1 "$RC"

# 15. hzcode alias resolves to the canonical binary
if [[ -e "$INSTALL_DIR/hzcode" ]]; then
    alias_sha=$(sha256sum -- "$INSTALL_DIR/hzcode" 2>/dev/null | cut -d' ' -f1 || echo missing)
    [[ "$alias_sha" == "$SHA" ]] && { echo "PASS alias-shares-digest"; PASS=$((PASS+1)); } || { echo "FAIL alias-shares-digest ($alias_sha)"; FAIL=$((FAIL+1)); }
fi

echo ""
echo "installer tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
