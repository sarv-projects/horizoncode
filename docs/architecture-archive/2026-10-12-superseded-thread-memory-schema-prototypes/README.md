# Superseded Thread/Memory schema prototypes

Historical, non-normative source preserved during the 2026-10-12 HorizonCode repository audit.

These prototypes modeled a Rust/Horizon-canonical Thread/Turn conversation and memory ranges keyed to that Thread. The adopted architecture supersedes that ownership model:

- direct conversations are owned by HorizonCode Core derived from the pinned OpenCode Session model;
- explicitly native backends own only their separate Sessions;
- Rust owns managed control, effects and evidence, not a second transcript;
- memory/history retrieval must reference backend-owned Session ranges through bounded correlation and provenance, not create a canonical Rust Thread transcript.

The files under `src/` and `test/` remain here only as provenance. Do not import them into runtime packages.

A future MemoryService machine contract must be designed against the adopted SessionLink/backend-owner model and added through the normal schema, ownership and acceptance gates.
