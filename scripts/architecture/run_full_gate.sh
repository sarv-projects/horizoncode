#!/usr/bin/env bash
# Full workspace release/CI validation (intentionally broader and slower).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
python3 scripts/architecture/bootstrap_source.py --check --require-complete
python3 scripts/architecture/audit_overlay_visibility.py
python3 scripts/architecture/audit_workspace_packages.py
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor
FULL_TYPECHECK_CONCURRENCY="${HORIZONCODE_FULL_TYPECHECK_CONCURRENCY:-1}"
# One-worker default avoids swap exhaustion on 8 GiB WSL and 7 GiB CI runners.
bun turbo typecheck --concurrency="$FULL_TYPECHECK_CONCURRENCY"
# New Settings metadata must pass real Bun unit tests, not only JSON Schema checks.
(cd packages/core && bun test test/config/feature-exposure.test.ts)
bash scripts/architecture/run_push_gate.sh
echo "Full HorizonCode validation passed."
