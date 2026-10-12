# HorizonCode implementation prompt

Read AGENTS.md, arch_V1/README.md, arch_V1/17-GOVERNANCE-DECISIONS.md, arch_V1/10-DELIVERY.md and HANDOFF.md. Use docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md as the operative checklist. For upstream extraction use arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md.

Then inspect git status, active processes, exact source/callers/tests for the first incomplete dependency in HANDOFF. Do not load the architecture archive or compatibility stubs.

Start at P1.3 universal ToolBatch Guard/ExecutionHost; recheck P1.2-B when modifying observer lifecycle. Do not jump ahead to effectful browser/desktop/DAP/REPL/plugin work before P1.3.

For a slice, retrieve only its owning architecture doc plus arch_V1/20-OPENCODE-INTEGRATION-LLD.md and/or arch_V1/37-RUNTIME-SERVICE-LLD.md, arch_V1/33 for capability IDs, arch_V1/32 for acceptance, and arch_V1/42 only for exact upstream source extraction.

Preserve OpenCode canonical Session conversation ownership. Rust owns managed control/effects, not a transcript. Route every mutation through the same Guard. Never silently change provider/model/harness or paid route.

Implement the smallest end-to-end vertical slice with positive, negative, cancellation/restart/UNKNOWN tests as relevant. Record exact evidence and continue to the next unblocked dependency. Push checks use scripts/architecture/run_push_gate.sh; full workspace typecheck remains scripts/architecture/run_full_gate.sh for release/CI. Preserve all user-owned dirty state; no destructive cleanup, commit or push without explicit authorization.
