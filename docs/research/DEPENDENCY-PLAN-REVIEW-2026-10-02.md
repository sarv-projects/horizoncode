# Dependency-plan review

Reviewed source revision: `7441b79191aa645ad0deda0341bb67dbd9c51b8a`, branch `main`,
2026-10-02. Three independent read-only comparisons covered repository health,
delivery dependencies and architecture owners. This is design/source-navigation
evidence, not runtime, benchmark or product acceptance.

## Corrections retained in the implementation guide

- HEAD tracks `cline-probe` as a gitlink at `d7250ad39400d1485fc11011a80fdab26aeeff83`
  without `.gitmodules`; `git submodule status --recursive` fails with no mapping.
  The configured CI checkout does not request submodule initialization and Cargo
  includes only `crates/*`. CI checkout failure is therefore unproven. A clean-clone
  reproduction/configured workflow record is required. The nested dirty checkout
  remains untouched; removing its pointer or defining a legitimate submodule needs
  a concrete preservation/repair plan under AX-001.
- The TODO/source-trail baseline of `262bdb2...` and claim of uncommitted Rust changes
  were stale: those source slices are present in HEAD. Their earlier checks remain
  historical dirty-tree evidence and cannot be promoted to integrated acceptance.
- AX-413..419 extend existing AX-201/202/320/375/400/408/411, AX-124/307/330/387,
  workspace and context owners. They do not create duplicate indexes, packets,
  policy engines, schedulers, skill registries or evaluation datasets.
- Safe batch/barrier/cancellation mechanics belong with runtime foundations.
  Optional Code Mode is evaluated after repository/context/pipeline features.
- A same-model OpenCode Go B0 requires AX-360/361 route implementation/conformance
  and authorized access. Source inventory AX-362 alone proves neither.
- A supervised `horizon-indexd` child can satisfy the existing prohibition on
  unsolicited detached daemons/listeners. Optional indexing starts after interaction
  readiness and raw guarded tools remain usable while it loads.

## Primary-source checks

| Source | Observation and boundary |
|---|---|
| [DeepSeek scheduler, retained pin](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/src/tool-calls.ts) | Existing `U-DSH-SCHEDULER` records full pinned inspection. A web check of the official repository on 2026-10-02 also describes bounded rolling pools, exclusive barriers, reclassification and model-ordered finalization. HorizonCode retains its own authority/settlement contracts; no source copied. |
| [Tree-sitter advanced parsing](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/3-advanced-parsing.md), [API](https://github.com/tree-sitter/tree-sitter/blob/master/lib/include/tree_sitter/api.h) | Incremental reuse requires editing the old tree to match the exact source delta before parsing with it. A watcher hint without exact edits is insufficient; reparse the changed file. These are mutable official documentation URLs checked 2026-10-02, not a grammar/library implementation pin. AX-414 must pin actual dependencies/grammars before use. |
| [Tantivy architecture](https://github.com/quickwit-oss/tantivy/blob/main/ARCHITECTURE.md), [official repository](https://github.com/quickwit-oss/tantivy) | BM25/full-text and incremental document replacement are available, but visibility depends on commit and reader reload. SQLite plus a full-text adapter cannot be described as one atomic transaction. Tantivy remains a candidate backend until pinned dependency review and measured evaluation; no speed claim or dependency adoption is made. Mutable documentation checked 2026-10-02. |
| [OpenCode getting started source](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/index.mdx) | Official installation/provider-connect guidance supports staged onboarding. Its convenience shell installation is not copied into HorizonCode's signed bootstrap policy. Supported routes/platforms must be probed by HorizonCode. Mutable docs checked 2026-10-02; existing composer implementation pins/URLs remain in `U-OC-COMPOSER-20260930`. |

The index daemon, overlay protocol, TaskPackage, ChangeReceipt and HZBench governance
are HorizonCode design synthesis. Upstream documentation supports individual mechanics;
it does not prove this combined design's performance or quality. Product-fit conclusions
require the existing developer task sessions and product acceptance scenarios.
