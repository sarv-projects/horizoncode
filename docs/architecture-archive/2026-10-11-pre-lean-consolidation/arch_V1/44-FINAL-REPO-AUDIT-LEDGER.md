# 44 — Repository file/line source audit, ownership risk ledger and truth of completion

**Final audit workstream, 2026-10-11. NOT an all-code semantic proof or product release approval.** Machine-readable manifest: [all Git-visible source paths with SHA256 and line counts](repo-file-line-audit-manifest.json). Ownership phrase evidence: [69 search candidates](ownership-phrase-audit-candidates.json). Immutable upstream references and exact extraction instructions: [§42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md), [§43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md), [new operative implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md).

## 44.1 Exact audit method and its limit

The actual Git repository was read in WSL at /home/sarvesh/business_Dev/agentx (first-party origin: git@github.com:sarv-projects/horizoncode.git), not guessed from an upstream clean checkout. Baseline Git HEAD bf0399469470c6ffdcbe5421dc5c506db2d61fae (subject to user/concurrent work). The traversal used git ls-files --cached --others --exclude-standard: every Git-visible regular file was opened and SHA256-byte-streamed, known text-source suffixes had line counts, and all Markdown relative references were parsed and checked on disk. Reproducible scanner: scripts/architecture/audit_repository.py --write.

The initial pass read **6,706 regular files** (with the then-present ignored/empty/symlink exclusions), **208 Markdown files** and **1,498,113 source/text lines**, totaling about **128 MB**, before newly added sources/plans and .svg text-count classification. The final stored manifest is regenerated after editing and is the definitive machine snapshot. This is **mechanical coverage of file contents**; it does not mean a human or model manually reasoned about all 1.5 million lines or proved the behavior of every code path. The baseline also has thousands of upstream vendor files and text/data/asset fixtures; these cannot be treated as newly reviewed implementation logic.

## 44.2 Actionable inconsistencies found and disposition

| ID | Finding | Action taken | Residual risk |
|---|---|---|---|
| AUD-01 | Historical P2 plan prescribes Rust as canonical Thread/Session writer, conflicting with §17 A-V2-11 | Added explicit operative successor plan and a link/banner forbidding execution of historical checkboxes | Old body intentionally remains as historical evidence; coding agent MUST read banner |
| AUD-02 | OMP research §§38–41 was detailed but not connected to implementation gate and source provenance | Built §42 immutable source register (12 repos, 23 extracted/adapt patterns), §43 source-to-HLD/LLD with owners/logic/tests, replacement current plan | These documents DO NOT implement or verify feature behavior |
| AUD-03 | UX/settings/provider/model/goal and streaming visuals had only proposed sources and weak implementation traceability | A-V2-22/23/24 record bounded target and extraction rules; linked §§09,10,16,19,20,23–27,29,31,32,34–37 and handoff | Actual interfaces remain subject to schema/TS+Rust/UAT, and some choices are intentionally open |
| AUD-04 | Relative-link candidates in archived Markdown and upstream test fixtures | Captured 18 candidate links in file manifest and classified 12 historical archive excerpts plus 6 OpenCode fixture references | Do not rewrite archive quotations or vendored fixture contracts merely to make a link scan green |
| AUD-05 | 69 mechanically matched old Rust-canonical ownership phrases | Source path+line ledger saved; operative owner amended in §§01–04/13/17/20 and active roadmap; historical text marked superseded | Regex matches include NEGATIONS/historical quotes; no automated proof all ownership prose semantically consistent |
| AUD-06 | Runtime-integrated source evidence missing for proposals | Strict missing-runtime status in §37/43/current plan; tests distinguish schema fixtures vs Bun/Rust existing IPC | New UX, native search/edit, browser/desktop, DAP, image/chart artifact services NOT shipped by docs |
| AUD-07 | Default-deny Git allowlist could silently hide new implementation plan/audit script | Narrowly allowlisted two specific added paths in .gitignore, not blanket project unignore | Inspect git status before committing as new files can remain untracked until staged |
| AUD-08 | Developer had requested source links for all borrowed algorithms | Source register stores exact URLs + pins and local ownership / security / integration test for each pattern | Future source upgrades and license/dependency closure still require review |

## 44.3 External repository reference coverage

The source register enumerates the first-party HorizonCode and 11 upstream/competitor repositories: anomalyco/opencode, can1357/oh-my-pi, deepseek-ai/deepseek-harness, openai/codex, cline/cline, xai-org/grok-build, anthropics/claude-code, SWE-agent/mini-swe-agent, OpenHands/OpenHands, OpenHands/software-agent-sdk, openinterpreter/openinterpreter. Exact commit refs are stored in external-source-register.json. The older source docs contain other websites and vendor fixture repos; generic site mentions are not adopted source dependencies. OMP source file links in this register were checked against its pinned git tree, but future code copy MUST still inspect actual file content, transitive dependencies and licensing on first use.

## 44.4 HLD↔LLD↔schema↔test crosswalk (actual statuses)

| Requirement | Design owner | Implementation truth and next proof |
|---|---|---|
| Session canonical owner | §§01,02,04,17; §20 source map | Core V2 code exists; P1.2 Session observer still needs full supervised integration proof |
| Effects/Guard | §§05,13,14,15,36,37; §43 B2 | P1.3 universal broker not proven, effect bypass enumeration required |
| Managed Goal/Run | §§02,11,12,15; §43 B3 | OwnerLog primitives exist; additive managed state, acceptance tests incomplete; old Rust Thread plan rejected |
| JSON Schema and TS/Rust | §§12,25,37 and contracts-v2 | JSON Schema parse/fixtures tested; corresponding runtime generated TS/Rust adapters not proved |
| Models/providers/roles/slash/settings | §§16,22,29,40,43 C3; §42 SRC-009 | Existing OpenCode infrastructure reused; OMP visual/catalog UI added as adopted target, no OMP UI integration |
| Native edit/scan/LSP/DAP | §§20,30,32,37,43 C1; §42 SRC-003/004/008 | Source candidates researched; no verified cross-platform native OMP port |
| Browser/desktop/web search | §§31–33,37,43 C2; §42 SRC-005..007 | APIs/design proposed, no claims live Guard coverage or backend working |
| SVG/Mermaid/chart/terminal graphics | §§31,37,41,43 C4; §42 SRC-010..013 | Pinned OMP source pipeline inspected; tests/adapters not landed |
| Artifact storage and fidelity | §§12,18,31,37,41/43; §42 SRC-014 | Existing Rust artifact primitives vs proposed full/sample typed semantics; file export and resilience not proved |
| UI display vs public screen stream | §§31,37,41; SRC-015/016 | Streaming design only; optional public broadcast explicitly deferred |
| Real-world acceptance | §§23,26,32 and current plan | Old narrow IPC/unit tests != full OS/browser/model/UAT |

## 44.5 What a coding agent must not falsely claim

- Schema parsing, 700+ architecture assertions or an inventory count do not establish that P1.3 Rust Guard is active in every effect path.
- Semantic line-by-line source review of 6,700 files is NOT achieved merely by SHA256 scanning; the next agent must inspect and test the specific function callgraph under change.
- Source provenance and license scanning do not imply actual code extraction, original contributor notices, or a valid platform binary.
- A visual SVG frame, generated chart or public screen stream is NOT a durable source artifact with a verified saved receipt.
- Status code labels SOURCE_INSPECTED, DESIGN_APPROVED, CODE_PRESENT, WIRED, TESTED, VERIFIED and RELEASED must not be conflated.
- Historical P2 spec/plan bodies still exist intentionally; the current replacement is the only executable plan.

## 44.6 Execution gate and audit repeatability

Use the current plan in docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md, beginning with active P1.2-B then P1.3. Before new code, reread exact source and tests, then source pin and license from §42, HLD/LLD from §43 and existing §17 owner. Write tests first and verify effects/recovery/OS UI, update risk ledger and handoff. Respect active user working tree. Run the mechanical scanner, scripts/architecture/validate_convergence.py, scripts/architecture/run_contract_tests.py, and relevant full TS/Rust actual suites if no competing builds; report any not run. Git diff --check checks whitespace, not architecture or runtime semantics.

Unresolved user-facing capability implementation is an implementation queue, **not a solved bug**. The audit fixes the handoff and owner-source contradictions it can substantiate; it cannot honestly certify the whole product is correct or completely implemented.

## 44.7 Ignored local reference repository audit

The original Git-visible manifest intentionally excludes non-tracked/ignored reference clones, generated caches, dependencies and Rust build outputs. The additional ignored-reference scan now covers *repos/cline* (4,173 files, 1,148,507 text lines), *repos/codex* (8,979 files, 2,338,229 text lines), and *repos/deepseek-harness* (14,119 files, 2,432,358 text lines): **27,271 files / 5,919,094 additional source/text lines**. Per-file hashes, sizes and line counts: [ignored-reference-source-manifest.json](ignored-reference-source-manifest.json), reproducible scanner scripts/architecture/audit_local_reference_copies.py.

Total **machine-read** coverage combining the last Git-visible source snapshot and three additional ignored reference trees is over 33,900 regular files and 7.4 million selected text lines. Not included: generated node_modules (~2.5GB), kernel/target build output (~524MB), disposable index database/cache, and unspecified hidden/ignored external worktrees; these are not treated as implementation source authority. The external local reference trees have no verified commit SHA; use the pinned GitHub source register instead. No manual semantic line-by-line review of 7.4M lines is claimed.

## 44.8 Last focused code/contract verification — 2026-10-11

The actual executable scripts/architecture/run_contract_tests.py was run on the live working tree before the local-reference inventory append: **four stages passed, zero failed**. Architecture/design schemas: 844 checks, 0 failed; source provenance: 376 checks, 0 failed; Bun Core-to-Rust Session projection: 5 tests, 52 expect calls, 0 failed; Rust session_rpc_delivery: 2 tests passed, 0 failed. **Final follow-up after the architecture/source documents and local-reference manifest were updated:** 847 architecture checks, 379 source-provenance checks, five Bun tests / 52 assertions, and two Rust RPC tests all passed; git diff --check passed. Counts refer to these focused checks only. Git diff --check passed. These are focused existing IPC/Session tests, not production/browser/desktop/DAP/visual-artifact acceptance.

