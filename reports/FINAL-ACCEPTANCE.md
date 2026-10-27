# Final V1 acceptance checklist (parent-owned)

## Current evidence (2026-10-26)

Repeatable V1 E2E: `bash scripts/e2e/v1-smoke.sh` (repo-local HOME/XDG/TMPDIR under `.tmp/e2e/smoke`, random loopback port, Basic auth from `OPENCODE_SERVER_PASSWORD`, trap-killed server, unauthenticated-401 negative probe, one `opencode/big-pickle` write turn asserting no `error`, exact `OK` content and cost 0; logs under `.tmp/e2e/logs/v1-smoke`).

Last result at HEAD `73e3876e7` (2026-10-26): **FAIL**.

```
E2E_V1_SMOKE=FAIL
EVIDENCE upto=assistant unauth=401 session=ses_e868bdf3cffeTyTeXcPhQA1tS6 assistant=done cost=0 write=none
EVIDENCE_FAIL step=assistant detail=assistant error present: {"name": "UnknownError", "data": {"message": "Session supervisor direct_provider_authority failed: direct provider pins require the authenticated Core AgentProfileV2 service"}}
```

Server health, catalog, session creation and the 401 probe passed; no `.tmp/e2e/ok.txt` was written. The row stays FAIL until the same command prints `E2E_V1_SMOKE=PASS`.

Run only after the nine phase reports claim source closure. No row is VERIFIED until the command has run on the exact revision and its output is captured.

## 0. Structural
- `python3 scripts/architecture/validate_convergence.py` → FAILURES 0
- `python3 scripts/architecture/audit_markdown_repo.py` → ACTIVE_BLOCKERS 0
- `python3 scripts/architecture/bootstrap_source.py --check --require-complete`
- `python3 scripts/architecture/audit_overlay_visibility.py`
- `python3 scripts/architecture/audit_workspace_packages.py`
- `python3 scripts/architecture/validate_external_sources.py`

## 1. Build / typecheck
- `cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor --bin hz-kernel`
- `cargo test --locked --manifest-path kernel/Cargo.toml` (or targeted family filters while triaging)
- `bun run horizoncode:typecheck` (opencode + tui + core)
- `bun turbo typecheck --concurrency=1` (full workspace; release gate)

## 2. Guard / effect security (§32.14, §32.19, §32.20, §32.43)
- ToolBatch denied before lease; lease reuse/widen denied.
- Cancel mid-effect → UNKNOWN → no blind retry.
- Plugin/MCP/hosted/legacy origins cannot bypass Guard.
- Workspace profile wrong digest / out-of-grant argv denied.
- Read fast path validates per-call and never admits mutation.
- Kernel push-gate tests: managed_control, resource_budget, tool-batch, hosted-tools, prompt Guard.

## 3. Managed lane (§32.9, §32.12, MPT-001, CM-*)
- No managed dispatch without live Attempt.
- Direct lane gains no managed receipts.
- Single Task → verifier PASS → aggregate settlement; bounded multi-Task on distinct Locations after prerequisites.
- Restart/pause/cancel/UNKNOWN recovery; no replay of non-idempotent effects.
- CodeMode: prepare/settle/wave receipts/cancel; mixed effect vs host_callback; no caller lease.

## 4. Context / RepoIntel (§32.4, §32.10–13, §32.45, §32.47)
- ContextSelection/ledger digest binds exact selection; no raw prompt leak.
- Stale generation → typed STALE; bounded pages; read-scope mismatch denied.
- §30.26 cache-anchor vs minimize-tokens; CX-014–021.
- Instruction resolver CX-022–025 / INST-001–008.
- Repo tools gated until P1+P3 acceptance.

## 5. Providers / Doctor / settings (§32.21, §32.31)
- No hidden provider/model switch on 429; no paid fallback.
- Doctor full tier requires consent; offline catalog freshness UNKNOWN.
- Credential lease exact match; zeroization; no secret in logs/artifacts.
- Feature exposure counts match real capability status.

## 6. TUI / artifacts / recovery (§32.16–17, §32.48)
- Streaming lanes stable; scroll anchor; 10k message load; keyboard-only approval.
- Artifact FULL/SAMPLE/FAILED fidelity; safe SVG/Mermaid; RAM budgets.
- Checkpoint/rewind restore or explicit UNKNOWN.
- Kill CLI mid-stream → restart → no duplicate messages.

## 7. Resources / worktrees (§32.32–33)
- Reservation states exact; impersonation/stale-owner negatives.
- Worktree lease conflict and recovery.
- Pressure ladder with measured evidence; OS hard quotas not claimed unless enforced.
- RC0 1/5/10/20 sessions raw evidence.

## 8. Real journeys
- Direct coding journey: provider pinned, edit via tool, test, no Guard bypass.
- Managed journey: goal propose → accept → task → verifier PASS.
- Context pressure: large log → trim/compact → continue.
- Reconnect/restart.
- Linux/WSL clean install of `horizoncode` and `hzcode`; upgrade/rollback.

## 9. Release
- `implementationtov1release.md` checklist reconciled.
- License/notices/provenance; signing/update truth; platform support truth.
- Exact task-owned staged paths only; commit/push after verified diff.

## Evidence
Record command, revision (`git rev-parse HEAD` at run time), platform, and result in `HANDOFF.md` and `reports/phases/`.
