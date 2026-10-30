#!/usr/bin/env bash
# Fail if any package emits TypeScript diagnostics (tsgo may exit 0 while printing errors).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/.tmp"
failed=0
out=""

remove_out() {
  if [[ -n "${out:-}" && -f "$out" ]]; then
    rm -f -- "$out"
  fi
  out=""
}

on_signal() {
  remove_out
  exit 130
}

trap remove_out EXIT
trap on_signal INT TERM

for pkg in horizoncode tui core; do
  out="$(mktemp "$ROOT/.tmp/horizoncode-typecheck.XXXXXX")"
  set +e
  (cd "$ROOT/packages/$pkg" && TMPDIR="$ROOT/.tmp" bun run typecheck 2>&1 | tee "$out")
  ec=$?
  set -e
  if [[ $ec -ne 0 ]]; then
    failed=1
  fi
  if [[ -f "$out" ]] && grep -q 'error TS' "$out"; then
    echo "horizoncode:typecheck: diagnostics in packages/$pkg" >&2
    failed=1
  fi
  remove_out
done
exit "$failed"
