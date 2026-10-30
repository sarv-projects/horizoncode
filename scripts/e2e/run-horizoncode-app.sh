#!/usr/bin/env bash
# End-to-end HorizonCode application check: one bootstrap, kernel, Nemotron route,
# coding task + slash dispatch. Exit non-zero on first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=lib/cgroup-scope.sh
. "$HZ_LIB_DIR/cgroup-scope.sh"
hz_ensure_scope "$@"

export NEMOTRON_PROVIDER_ID="${NEMOTRON_PROVIDER_ID:-nvidia}"
export NEMOTRON_MODEL_ID="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"

KERNEL_BIN="$ROOT/kernel/target/debug/hz-kernel"
if [ ! -x "$KERNEL_BIN" ]; then
  echo "run-horizoncode-app: building hz-kernel…" >&2
  (cd "$ROOT/kernel" && cargo build --bin hz-kernel)
fi

echo "== HorizonCode launcher =="
bash "$ROOT/scripts/horizoncode" --version

echo "== py-task (coding + tests) =="
bash "$ROOT/scripts/e2e/py-task.sh"

echo "== slash dispatch (issues, translate, commit) =="
bash "$ROOT/scripts/e2e/slash-probe-one.sh" issues translate commit

echo "HORIZONCODE_APP=DONE"
