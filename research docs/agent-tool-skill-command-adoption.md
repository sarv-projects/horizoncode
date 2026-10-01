# Focused agent tool and skill pattern review

Reviewed 2026-09-29. This is a focused review of four pinned files/patterns, not a
line-by-line audit of the upstream repositories. No source code, schemas, tests, or
assets were copied.

## Findings and HorizonCode disposition

| Pattern | Pinned source and observed behavior | HorizonCode owner and adaptation |
|---|---|---|
| Grok skill invocation and creation | xAI Grok Build, Apache-2.0, commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`: [`08-skills.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md). The guide documents guided `/create-skill` (scope, name, description, draft, directory and `SKILL.md`) and preserves colliding skill names with a source-qualified slash command while the built-in keeps the bare command. | `DEC-080`, `REQ-SKILL-005`, `ARCH/21` skill routing/Create wizard, `ARCH/27` command route; `AX-373` activation and `AX-378` Create UI. HorizonCode adds digest revalidation, explicit preview/guard/audit, no overwrite, and no auto-enable. `/skill` is manager navigation; `/create-skill` is a deep link to the same Skills → Create surface. |
| Codex lazy tool discovery | OpenAI Codex, Apache-2.0, commit `67a709665ac7b50311b93e32612c9a8281684787`: [`tool_search.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/tools/handlers/tool_search.rs). This file contains deferred tool specs and bounded tool search. The source uses BM25; this review adopts the deferred-schema pattern, not a mandated ranking algorithm. | Existing `REQ-CTX-010`; `ARCH/10` bounded metadata search and selected-schema materialization in the one registry; `AX-373` implementation. Require permission/schema/catalog pinning and stale refusal. Evaluate exact-name and natural-language retrieval before choosing a ranking implementation. |
| OpenCode LSP tool | OpenCode, MIT, commit `b471c2b4495747353af768fbf2e0790c9d820ce2`: [`lsp.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/tool/lsp.ts). The file groups definition, references, hover, document/workspace symbols, implementation, and call-hierarchy operations behind one tool, and checks external-directory access, LSP permission, file existence, and server availability. | Existing `REQ-CTX-012`; `ARCH/09` and `CMP-repo-intel` define one HorizonCode repository-intelligence/LSP owner; `AX-375` implementation. Preserve revision/freshness evidence and labeled fallback; do not introduce another index or LSP server manager. |
| Grok Doctor and shared Extensions | Existing focused notes [`grok-build-doctor.md`](grok-build-doctor.md) and [`grok-build-extensions.md`](grok-build-extensions.md) pin the same Grok Build commit and contain their observed paths/limits. | Keep proposed `DEC-079`/`AX-392` Doctor design and `DEC-078`/`AX-378` shared Extensions routing. This pass adds no duplicate task or service. |

## Provenance and limits

Repository license files at the cited pins were inspected: Grok Build is Apache-2.0,
Codex is Apache-2.0, and OpenCode is MIT. This records provenance only; the decision is
to adapt public behavior, not copy code. The relevant source trails are `U-GROK-SKILLS`,
`U-CX-TOOL-SEARCH`, and `U-OC-LSP` in `docs/research/SOURCE-TRACEABILITY.md`; the source ledger records these as
pattern-only under `SRC-031`–`SRC-033`. Any future source copying still requires the
per-file gate in `docs/research/SOURCE-LEDGER.md` and task `AX-001`/`AX-010`.

The three files were reviewed for the stated pattern only. This does not establish full
repository behavior, compatibility, security, or HorizonCode implementation evidence.
