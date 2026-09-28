# Helix editor architecture patterns

**Source.** The upstream architecture overview is
[`docs/architecture.md`](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/docs/architecture.md)
at commit `079a789e8cb08ead67f19e1971a1b7438b37354b` (2026-07-23).
It describes separate editing primitives (`helix-core`), LSP client/types,
`helix-view`, and terminal UI crates. It is used only as a high-level architecture
reference. The repository's `LICENSE` at that pinned commit is Mozilla Public License
2.0; HorizonCode copies no Helix code and adds no Helix dependency. Any future
dependency or source adaptation needs a separate license and provenance review.

## Useful design lesson

Keep text-buffer operations, editor/document state, language-service integration, and
terminal rendering as separate interfaces. HorizonCode's embedded editor remains
deliberately smaller: bounded buffer editing and syntax highlighting, with LSP and
external-editor integration behind separate adapters. This can keep the TUI light and
allow the terminal editor to be disabled while repository navigation/chat continue.

## HorizonCode disposition

See `ARCH/06` §§5–8 and `ARCH/09`. The editor opens inside the left Explorer dock
group, while chat stays central and Tasks remain a right-side verified projection.
Do not copy Helix modal behavior or assume its editor features are needed in v1. The
existing editor size limits, governed write path, conflict handling, and external
editor escape hatch remain the acceptance boundary.
