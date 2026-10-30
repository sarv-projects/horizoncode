#!/usr/bin/env bash
# Fast, strict Git-push gate over HorizonCode's actively changed runtime.
# Full monorepo checking is still mandatory in CI/release: run_full_gate.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
echo "HorizonCode push gate: source, contracts, HorizonCode typing, real Guard regressions"
git diff --check
git diff --cached --check
python3 scripts/architecture/bootstrap_source.py --check --require-complete
python3 scripts/architecture/audit_overlay_visibility.py
python3 scripts/architecture/audit_workspace_packages.py
python3 scripts/architecture/validate_convergence.py
python3 scripts/architecture/audit_markdown_repo.py
python3 scripts/architecture/validate_external_sources.py
echo "Typechecking the HorizonCode CLI/TUI host and Core"
bun run horizoncode:typecheck
# Never silently skip positive Rust Guard tests due to an absent binary.
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor --bin hz-kernel --quiet
# P2 owner durability must execute its replay/fencing regressions in hosted CI.
cargo test --locked --manifest-path kernel/Cargo.toml --test managed_control --quiet
cargo test --locked --manifest-path kernel/Cargo.toml --lib resource_budget --quiet
test -x kernel/target/debug/session_supervisor
# `bun test -t <name>` exits 0 when the filter matches no test: every named
# invocation captures its output and requires a positive reported pass count.
run_named_test() {
  local name="$1" timeout_ms="$2" file="$3" output passed
  if ! output="$(bun test --timeout "$timeout_ms" "$file" -t "$name" 2>&1)"; then
    printf '%s\n' "$output"
    echo "HorizonCode push gate: bun test failed: $file -t '$name'" >&2
    return 1
  fi
  printf '%s\n' "$output"
  passed="$(printf '%s\n' "$output" | sed -nE 's/^[[:space:]]*([0-9]+) pass.*$/\1/p' | tail -n 1)"
  if [ -z "$passed" ] || [ "$passed" = 0 ]; then
    echo "HorizonCode push gate: $file -t '$name' reported no passing test (${passed:-0} pass); the filter is stale" >&2
    return 1
  fi
}
(
  cd packages/core
  bun test --timeout 60000 test/session-runner-tool-registry.test.ts
  bun test --timeout 60000 test/tool-write.test.ts
  run_named_test 'Core Effect admits and settles a files.write' 80000 test/kernel-projection-live.test.ts
)
(
  cd packages/horizoncode
  bun test --timeout 60000 test/session/tools.test.ts
  bun test --timeout 60000 test/session/run-state-owner.test.ts
  bun test --timeout 60000 test/session/tool-batch.test.ts
  bun test --timeout 60000 test/session/hosted-tools.test.ts
  bun test --timeout 60000 test/tool/write.test.ts
  run_named_test Guard 60000 test/session/prompt.test.ts
  run_named_test 'V1 model write is admitted' 60000 test/session/prompt.test.ts
)
echo "HorizonCode push gate passed. For full validation run: bash scripts/architecture/run_full_gate.sh"
