# Kilo Code repository indexing reference

**Scope and pin.** Reviewed the Kilo Code documentation files at repository commit
[`e9948b6000697757ceea194403750cd80effe70c`](https://github.com/Kilo-Org/kilocode/tree/e9948b6000697757ceea194403750cd80effe70c):
[`codebase-indexing.md`](https://github.com/Kilo-Org/kilocode/blob/e9948b6000697757ceea194403750cd80effe70c/packages/kilo-docs/pages/customize/context/codebase-indexing.md)
and [`semantic-search.md`](https://github.com/Kilo-Org/kilocode/blob/e9948b6000697757ceea194403750cd80effe70c/packages/kilo-docs/pages/automate/tools/semantic-search.md).
This is documentation evidence, not a full implementation audit or benchmark.

The indexing docs describe an explicit opt-in: code is parsed into Tree-sitter
semantic blocks, embeddings are created using a configurable provider, vectors are
stored in a configurable vector store, and `semantic_search` becomes available.
Listed embedding choices include remote providers and local Ollama; the docs describe
LanceDB as embedded/file-based and Qdrant as an external option. The stated default is
disabled until globally or per-project enabled. This is useful evidence for a
default-off, inspectable semantic-index preference and for separating source parsing,
embedding provider, vector storage, and the model-facing retrieval tool.

HorizonCode's proposed retrieval contract is in `ARCH/09` / `REQ-CTX-014`: lexical
search and syntax/reference evidence remain useful without embeddings; local
embedding/indexing can be selected explicitly; remote embedding requires disclosure
and separate egress authority. We do not adopt Kilo implementation code or claim its
relevance/latency results apply to HorizonCode. PowerShell in this task means a
configurable shell for command execution (`ARCH/10`), not a semantic-index source
language requirement.
