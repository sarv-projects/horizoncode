#!/usr/bin/env bash
# Fast, strict Git-push gate over HorizonCode's actively changed runtime.
# Full monorepo checking is still mandatory in CI/release: run_full_gate.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
echo "HorizonCode push gate: source, contracts, Core typing, real Guard regressions"
git diff --check
git diff --cached --check
python3 scripts/architecture/bootstrap_source.py --check --require-complete
python3 scripts/architecture/audit_overlay_visibility.py
python3 scripts/architecture/audit_workspace_packages.py
python3 scripts/architecture/validate_convergence.py
python3 scripts/architecture/audit_markdown_repo.py
python3 scripts/architecture/validate_external_sources.py
# Never silently skip positive Rust Guard tests due to an absent binary.
cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor --quiet
# P2 owner durability must execute its replay/fencing regressions in hosted CI.
cargo test --locked --manifest-path kernel/Cargo.toml --test managed_control --quiet
cargo test --locked --manifest-path kernel/Cargo.toml --lib resource_budget --quiet
test -x kernel/target/debug/session_supervisor
(
  cd packages/core
  bun run typecheck
  bun test --timeout 60000 test/session-runner-tool-registry.test.ts
  bun test --timeout 80000 test/kernel-projection-live.test.ts -t 'Core Effect admits and settles a files.write'
)
(
  cd packages/opencode
  bun run typecheck
  bun test --timeout 60000 test/session/tools.test.ts
  bun test --timeout 60000 test/session/run-state-owner.test.ts
  bun test --timeout 60000 test/session/tool-batch.test.ts
  bun test --timeout 60000 test/session/hosted-tools.test.ts
  bun test --timeout 60000 test/tool/write.test.ts
  bun test --timeout 60000 test/session/prompt.test.ts -t Guard
  bun test --timeout 60000 test/session/prompt.test.ts -t 'V1 model write is admitted'
)
echo "HorizonCode push gate passed. For full validation run: bash scripts/architecture/run_full_gate.sh"
