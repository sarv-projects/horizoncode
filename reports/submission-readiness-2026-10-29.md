# Submission readiness — HorizonCode

**Date:** 2026-10-29 · **Mode:** cross-check of repo state, not a wish list · **Verdict: NOT READY**

Everything below is either measured by the orchestrator today or explicitly marked
*(subagent-reported)*. Nothing is assumed.

## 1. Three separate questions, three answers

| Question | Answer | Basis |
|---|---|---|
| Ready to submit? | **No** | no demo URL, no video, no feedback section, 187 dirty paths (`git status --porcelain \| wc -l`), no v1 wire accepted |
| A complete coding agent? | **No** | works end to end, but 1 in 4 tool calls fails and "done" is model self-report |
| Matches v1 release? | **No** | `arch_V1/46-V1-WIRE-TRACKER.md`, counted 2026-10-29: **0 Done · 73 Partial · 12 Not done · 1 N/A** over 86 ID rows (the older "226 / 4 `code_present` / 0 wired" header was not derivable from the rows) |

## 2. What is genuinely proven

| Claim | Evidence |
|---|---|
| Can build a real product from a brief | `bench/fullstack/meterbase-verified-20261029151801`: 2,428 lines, 20/20 held-back acceptance tests, 33/33 self-authored, 29.3 min, 165 tool calls |
| Actually consults online documentation | `docs/provenance.md` lists 6 URLs; all 6 re-fetched by the orchestrator and the quoted facts confirmed present on the pages (RFC 9457, RFC 6750 §3, Stripe signatures, IETF RateLimit draft, ISO 4217) |
| Fixes real bugs | SWE-bench: 5 of 6 executable tasks had every FAIL_TO_PASS fixed; 0 runnable-test regressions |
| Builds a stdlib Python package from a brief | `reports/py/RESULTS.md` retrykit: 19 tool calls / 10 errors (47 %), 4 files, 438 LOC, own suite `Ran 23 tests … OK`, independent check **25/25 → VERIFIED** (this task permitted repair) |
| Builds a stdlib Python CLI from a brief | `reports/py/RESULTS.md` auditlog ×2: 31 calls / 8 errors (74 %) and 35 calls / 6 errors (83 %), 774 and 919 LOC, own suite `Ran 44 tests … OK` both times, independent check **21/22** and **20/22 → PARTIAL** |
| Terminal/TUI surface works | TUI PTY journey 7/7 (earlier run) |
| Runs on an NVIDIA open model via models.dev | `nvidia/nemotron-3.5-super-vl-120b-a12b`, tool calls confirmed against the live API |

## 3. What is broken (measured, same 165-call run)

| Defect | Scale | Root cause | Status |
|---|---|---|---|
| `edit` lease denial | 22 of 61 edits in this run; 28 across the four runs measured in `docs/reliability/2026-10-29-reliability-program.md` | multi-call batches drop the per-call `lease`; 11/11 multi-edit batches denied, 34/34 single-edit clean | **still unfixed** |
| `edit` invalid arguments | 13 of 61 | model shape rejected by admission | fix in flight |
| `bash` invalid effect batch | 4 of 66 | kernel rejection collapsed into one opaque TS string | fix in flight |
| `web.search` never dispatches | 0 dispatches, ever | kernel rejects pre-dispatch before `authorize_http_preflight`; tool then misreports `UNKNOWN` with `attempts=[]` | fix in flight |
| `files.write` denied on a fresh directory | 9, every run | `path_unavailable_or_unsafe`: `effect_host.rs:11894` turned any `inspect()` error into that denial, and the parent directory did not exist yet | **FIXED 2026-10-29**: `inspect_write_target` separates `Present`/`Absent`/`MissingParent` from real denials, and the effect creates the chain with component-wise `mkdirat` off the workspace root fd. `kernel/tests/effect_direct_write.rs` 5/5 (nested `a/b/c/file.txt` at mode `0o755`, overwrite keeps `existed: true`, `../../escape.txt` still denied) |
| `bash` fails with a bare error tag | 6 | `Pty.InvalidInputError` reached the model with no reason even though `pty.ts:1538`/`:1109` raise real reasons | **FIXED 2026-10-29**: every `Pty` typed error now carries its `reason` in `message` (`core/src/pty.ts`), and `tool/shell.ts` names exactly which of `command`/`cwd`/`timeoutMs` is missing before the kernel can collapse it into a tag |
| `task` / subagent dispatch | every call, all 10 profiles | the Task tool routes through `ManagedControl.beginDirectTurn`, gated by `DIRECT_CHILD_TURN_RPC_ENABLED = false` (`packages/horizoncode/src/session/managed-control.ts:86`) | fails closed by design |

Net tool-call success: **75 %** in the product run, **48 %** across the SWE-bench runs.

## 4. What is missing for "complete"

- LSP is never exposed (`lsp/launch.ts` returns `false`); repo-intel answers `UnsupportedOperation`.
- No signed `VerificationReceipt` — success is the model's self-report, which `AGENTS.md §10` forbids.
- `horizoncode run` cannot mutate (no ServerAuth principal).
- Provider onboarding in the TUI is refused by design (SecretBroker).
- 21 of 22 slash commands unproven.
- Test suites not green: kernel `593 pass / 1 fail`, `packages/core 1409 pass / 90 fail / 5 errors` *(subagent-reported)*.

## 5. v1 release cross-check

`arch_V1/46-V1-WIRE-TRACKER.md` **formerly stated** its own registry as **226 designed / 4 `code_present` / 0 `wired` of 230**; that line was not derivable from the file's rows (no `code_present` value appears in any of them — the token appeared only in the header — and 226/230 are backlog-ID totals). Corrected in the tracker on 2026-10-29; counting its Status column gives **0 Done · 73 Partial · 12 Not done · 1 N/A over 86 ID rows**, or **0 Done · 76 Partial · 13 Not done · 7 N/A over 96 rows** once the exposure-tier and explicitly-not-V1 tables are included. The policy statement is unaffected and still holds: effectful tools stay fail-closed until P1 + direct transport are Done.

## 6. Minimum path to a submittable state

1. Land the four in-flight fixes and re-run the product journey requiring **0 tool errors**.
2. Re-run `scripts/e2e/v1-tui-pty-journey.sh` and `scripts/e2e/v1-live-provider.sh` after the kernel rebuilds.
3. Commit a clean tree (187 paths dirty across concurrent work, counted 2026-10-29 18:07 UTC).
4. Publish the repo, record a 3-minute build of Meterbase, add the feedback section.

Steps 1–2 are engineering. Steps 3–4 cannot be done on a dirty tree and are the
real gate — they are also the cheapest part once the numbers above move.

## 5. Reliability remediation landing record (2026-10-29/30)

| item | state |
|---|---|
| A1 missing-parent `files.write` | **fixed + proven** — `cargo test --test effect_direct_write` 5/5 |
| A2 opaque `Pty.InvalidInputError` | **fixed** — reasons now reach the model; shell tool explains incomplete argument sets; `bun run` module load of `tool/shell.ts` clean |
| Launcher from a bare checkout | **fixed** — `packages/horizoncode/bin/opencode` falls back to the TS entrypoint under bun instead of exiting "could not resolve a compatible Linux CLI binary"; `./bin/horizoncode --version` prints `local` |
| A3 multi-call `edit` lease | **open** — five attempts failed; correct model is one admission = one lease over the operation set |
| Coverage / evidence gate | **designed, not built** — `docs/reliability/2026-10-29-reliability-program.md` |
| Subagent lane | **dead by flag** — `DIRECT_CHILD_TURN_RPC_ENABLED = false` |
